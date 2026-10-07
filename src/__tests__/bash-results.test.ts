import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";
import { killProcessTree } from "../spawn.ts";
import { EVENT, type Job } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolDef {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
    }>;
}

interface CapturedMessage {
    customType: string;
    content: string;
}

function harness() {
    let tool: ToolDef | undefined;
    const messages: CapturedMessage[] = [];
    const pi = {
        registerTool: (def: ToolDef) => { tool = def; },
        sendMessage: (m: CapturedMessage) => { messages.push(m); },
    };
    const reg = new BackgroundRegistry();
    registerBashTool(pi as never, reg, {} as never);
    const ctx = {
        cwd: process.cwd(),
        ui: {
            notify: () => {},
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_c: string, t: string) => t },
        },
    };
    return { tool: tool!, reg, ctx, messages };
}

function onlyJob(reg: BackgroundRegistry): Job {
    const jobs = [...reg.jobs.values()];
    assert.equal(jobs.length, 1);
    return jobs[0] as Job;
}

void describe("bash tool — Claude Code tool-result strings", () => {
    const spawnedPids: number[] = [];

    void it("run_in_background returns the generic CC string (no Name fragment)", async () => {
        const { tool, reg, ctx } = harness();
        const res = await tool.execute(
            "t1",
            { command: "tail -f /dev/null", run_in_background: true, description: "my job" },
            undefined,
            undefined,
            ctx
        );
        const job = onlyJob(reg);
        spawnedPids.push(job.pid);
        assert.equal(
            res.content[0].text,
            `Command running in background with ID: ${job.id}. Output is being written to: ${job.logPath}`
        );
    });

    void it("manual background (Ctrl+Shift+B) returns the manual CC string", async () => {
        const { tool, reg, ctx } = harness();
        const pending = tool.execute(
            "t2",
            { command: "tail -f /dev/null" },
            undefined,
            undefined,
            ctx
        );
        await sleep(400);
        reg.foreground.get("t2")?.requestPause("manual");
        const res = await pending;
        const job = onlyJob(reg);
        spawnedPids.push(job.pid);
        assert.equal(
            res.content[0].text,
            `Command was manually backgrounded by user with ID: ${job.id}. Output is being written to: ${job.logPath}`
        );
        assert.deepEqual(res.structuredContent, { job_id: job.id, output_path: job.logPath });
    });

    void it("timeout auto-background returns the same generic CC string", async () => {
        const { tool, reg, ctx } = harness();
        const res = await tool.execute(
            "t3",
            { command: "tail -f /dev/null", timeout: 1 },
            undefined,
            undefined,
            ctx
        );
        const job = onlyJob(reg);
        spawnedPids.push(job.pid);
        assert.equal(
            res.content[0].text,
            `Command running in background with ID: ${job.id}. Output is being written to: ${job.logPath}`
        );
    });

    void it("timeout auto-background also fires in non-interactive (no-TTY) sessions", async () => {
        const { tool, reg, ctx } = harness();
        reg.nonInteractive = true;
        const res = await tool.execute(
            "t3n",
            { command: "tail -f /dev/null", timeout: 1 },
            undefined,
            undefined,
            ctx
        );
        const job = onlyJob(reg);
        spawnedPids.push(job.pid);
        assert.equal(
            res.content[0].text,
            `Command running in background with ID: ${job.id}. Output is being written to: ${job.logPath}`
        );
    });

    void it("timeout kill (auto-background not allowed) appends 'Command timed out after Ns' to the log", async () => {
        const { tool, ctx } = harness();
        // `sleep` is excluded from auto-backgrounding, and a float duration
        // slips past the blocked-sleep guard — so this hits the kill path.
        const res = await tool.execute(
            "t4",
            { command: "sleep 1.5", timeout: 1 },
            undefined,
            undefined,
            ctx
        );
        assert.match(res.content[0].text, /Command timed out after 1s\n\nCommand exited with code 143$/);
        assert.equal(res.structuredContent?.exit_code, 143);
        assert.equal(res.isError, true);
    });

    void it("a foreground command killed by an external signal is an error", async () => {
        const { tool, reg, ctx } = harness();
        const pending = tool.execute("t4k", { command: "echo started; tail -f /dev/null" }, undefined, undefined, ctx);
        await sleep(300);
        killProcessTree(onlyJob(reg).pid, "SIGKILL");
        const res = await pending;
        assert.equal(res.isError, true);
        assert.equal(res.content[0].text, "started\n\nCommand exited with code 137");
        assert.equal(res.structuredContent?.exit_code, 137);
    });

    void it("a turn abort kills the command and reports it as aborted", async () => {
        const { tool, ctx } = harness();
        const ac = new AbortController();
        const pending = tool.execute("t4a", { command: "echo started; tail -f /dev/null" }, ac.signal, undefined, ctx);
        await sleep(300);
        ac.abort();
        const res = await pending;
        assert.equal(res.isError, true);
        assert.equal(res.content[0].text, "started\n\nCommand aborted");
        assert.equal(res.structuredContent?.exit_code, 143);
    });

    void it("an external signal death is reported as killed ('was stopped'), never completed", async () => {
        const { tool, reg, ctx, messages } = harness();
        await tool.execute(
            "t5",
            { command: "tail -f /dev/null", run_in_background: true },
            undefined,
            undefined,
            ctx
        );
        const job = onlyJob(reg);
        // External kill — node reports code null + the signal; the job must
        // NOT be misreported as completed.
        killProcessTree(job.pid, "SIGKILL");
        await sleep(300);

        const terminals = messages.filter((m) => m.customType === EVENT.taskNotification);
        assert.equal(terminals.length, 1);
        assert.ok(terminals[0].content.includes("<status>killed</status>"));
        assert.ok(terminals[0].content.includes("was stopped"));
        assert.ok(!terminals[0].content.includes("completed"));
        assert.equal(job.status, "killed");
    });

    after(() => {
        for (const pid of spawnedPids) {
            try { killProcessTree(pid, "SIGKILL"); } catch { /* already gone */ }
        }
    });
});

void describe("bash tool \u2014 structured results for codemode", () => {
    const spawnedPids: number[] = [];

    void it("a successful command resolves to its output, exit code and wall time", async () => {
        const { tool, ctx } = harness();
        const res = await tool.execute("s1", { command: "printf hi" }, undefined, undefined, ctx);
        const { wall_time_seconds, ...rest } = res.structuredContent ?? {};
        assert.deepEqual(rest, { output: "hi", truncated: false, exit_code: 0 });
        assert.equal(typeof wall_time_seconds, "number");
        assert.equal(res.isError, undefined);
    });

    void it("a failing command returns an error result with its exit code instead of throwing", async () => {
        const { tool, ctx } = harness();
        const res = await tool.execute(
            "s2",
            { command: "echo out; echo err >&2; exit 3" },
            undefined,
            undefined,
            ctx
        );
        assert.equal(res.isError, true);
        assert.equal(res.content[0].text, "out\nerr\n\nCommand exited with code 3");
        assert.equal(res.structuredContent?.output, "out\nerr\n");
        assert.equal(res.structuredContent?.exit_code, 3);
    });

    void it("empty output is an empty string", async () => {
        const { tool, ctx } = harness();
        const res = await tool.execute("s3", { command: "true" }, undefined, undefined, ctx);
        assert.equal(res.structuredContent?.output, "");
        assert.equal(res.content[0].text, "(no output)");
    });

    void it("a failing command with no output reports only its status", async () => {
        const { tool, ctx } = harness();
        const res = await tool.execute("s3e", { command: "exit 2" }, undefined, undefined, ctx);
        assert.equal(res.isError, true);
        assert.equal(res.content[0].text, "Command exited with code 2");
    });

    void it("output over 1 MiB keeps head and tail and leaves the full log on disk", async () => {
        const { tool, ctx } = harness();
        const res = await tool.execute(
            "s4",
            { command: "head -c 1200000 /dev/zero | tr '\\0' a; echo END" },
            undefined,
            undefined,
            ctx
        );
        const sc = res.structuredContent ?? {};
        const fullPath = sc.full_output_path as string;
        assert.equal(sc.truncated, true);
        assert.ok(existsSync(fullPath));
        assert.equal(statSync(fullPath).size, 1_200_004);
        assert.ok(/^a+\n\n\[\.\.\. 151428 bytes omitted \.\.\.\]\n\na+END\n$/.test(sc.output as string));
        unlinkSync(fullPath);
    });

    void it("run_in_background resolves to the job id and output path", async () => {
        const { tool, reg, ctx } = harness();
        const res = await tool.execute(
            "s5",
            { command: "tail -f /dev/null", run_in_background: true },
            undefined,
            undefined,
            ctx
        );
        const job = onlyJob(reg);
        spawnedPids.push(job.pid);
        assert.deepEqual(res.structuredContent, { job_id: job.id, output_path: job.logPath });
    });

    after(() => {
        for (const pid of spawnedPids) {
            try { killProcessTree(pid, "SIGKILL"); } catch { /* already gone */ }
        }
    });
});
