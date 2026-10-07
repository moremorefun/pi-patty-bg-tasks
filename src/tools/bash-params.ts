/**
 * Bash parameter and output schemas (TypeBox) used by the overridden `bash` tool.
 */

import { Type } from "@earendil-works/pi-ai";

export const bashParamSchema = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default: 120)" })
    ),
    run_in_background: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to run this command in the background immediately. " +
                "Output is saved to /tmp/pi-bg/<jobId>.log.",
        })
    ),
    description: Type.Optional(
        Type.String({ description: "Short description of what this command does" })
    ),
});

export const bashOutputSchema = Type.Union([
    Type.Object({
        output: Type.String(),
        truncated: Type.Boolean(),
        full_output_path: Type.Optional(Type.String()),
        exit_code: Type.Number(),
        wall_time_seconds: Type.Number(),
    }),
    Type.Object({
        job_id: Type.String(),
        output_path: Type.String(),
    }),
]);
