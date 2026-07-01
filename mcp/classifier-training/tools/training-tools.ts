// ============================================================
// Classifier Training — Training execution MCP tools
// ============================================================

import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ── Training state (in-process, survives across tool calls) ──

let trainingProcess: ChildProcess | null = null;
let trainingStartTime: string | null = null;
let trainingLog: string[] = [];
const MAX_LOG_LINES = 200;

function resolveProjectRoot(): string {
  return process.cwd(); // MCP started from project root per .mcp.json config
}

function scriptDir(): string {
  return join(resolveProjectRoot(), "scripts", "train-router");
}

/**
 * Resolve the Python interpreter to use for training.
 * Checks in order: CLASSIFIER_PYTHON env var, then the standalone project venv,
 * then falls back to system python3.
 */
function pythonPath(): string {
  if (process.env.CLASSIFIER_PYTHON) return process.env.CLASSIFIER_PYTHON;
  // Try the standalone project venv
  const venvPython = "/Users/xin/tessel-classifier-training/.venv/bin/python3";
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}

// ── Tool Definitions ──

export const TRAINING_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (input: Record<string, unknown>) => unknown;
}> = [
  {
    name: "training_start",
    description:
      "Start classifier retraining asynchronously. Spawns train.py with the current dataset. Returns immediately with process PID and log file path.",
    inputSchema: z.object({
      epochs: z.number().optional().describe("Number of training epochs (default 20)"),
      batchSize: z.number().optional().describe("Training batch size (default 16)"),
    }),
    handler: (input) => {
      if (trainingProcess && trainingProcess.exitCode === null) {
        return {
          error: "Training is already running",
          pid: trainingProcess.pid,
          startTime: trainingStartTime,
        };
      }

      const epochs = (input["epochs"] as number) ?? 20;
      const batchSize = (input["batchSize"] as number) ?? 16;

      const dir = scriptDir();
      const dataPath = join(dir, "data", "data.jsonl");
      const modelDir = join(dir, "model");
      const baseModel = join(dir, "base-model");
      const trainScript = join(dir, "train.py");

      // Pre-flight checks
      if (!existsSync(trainScript)) {
        return { error: `train.py not found at ${trainScript}` };
      }
      if (!existsSync(dataPath)) {
        return { error: `Training data not found at ${dataPath}` };
      }
      if (!existsSync(baseModel)) {
        return { error: `Base model not found at ${baseModel}. Run: ln -sf <path-to-base-model> ${baseModel}` };
      }

      trainingLog = [];
      trainingStartTime = new Date().toISOString();

      trainingProcess = spawn(
        pythonPath(),
        [
          trainScript,
          "--data", dataPath,
          "--model-dir", modelDir,
          "--base-model", baseModel,
          "--epochs", String(epochs),
          "--batch-size", String(batchSize),
        ],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const pid = trainingProcess.pid;

      // Collect stdout
      trainingProcess.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            trainingLog.push(`[stdout] ${line}`);
            if (trainingLog.length > MAX_LOG_LINES) trainingLog.shift();
          }
        }
      });

      // Collect stderr
      trainingProcess.stderr?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            trainingLog.push(`[stderr] ${line}`);
            if (trainingLog.length > MAX_LOG_LINES) trainingLog.shift();
          }
        }
      });

      // On completion, try to restart the serve.py process to reload the new model
      trainingProcess.on("exit", (code) => {
        trainingLog.push(`[system] Training process exited with code ${code}`);
        if (trainingLog.length > MAX_LOG_LINES) trainingLog.shift();

        if (code === 0) {
          trainingLog.push("[system] Attempting to restart inference server to reload model...");
          // Kill existing serve.py and restart
          const restart = spawn(
            "bash",
            ["-c", "pkill -f 'python3.*serve.py' 2>/dev/null; sleep 1; nohup python3 serve.py --model-dir model/ > /tmp/tessel-classifier-serve.log 2>&1 & echo $!"],
            { cwd: dir, stdio: "pipe", shell: false },
          );
          restart.stdout?.on("data", (chunk: Buffer) => {
            const pid = chunk.toString().trim();
            if (pid) {
              trainingLog.push(`[system] Inference server restarted (PID: ${pid})`);
              if (trainingLog.length > MAX_LOG_LINES) trainingLog.shift();
            }
          });
        }

        trainingProcess = null;
        trainingStartTime = null;
      });

      trainingLog.push(`[system] Training started — PID: ${pid}, epochs: ${epochs}, batch: ${batchSize}`);

      return {
        started: true,
        pid,
        epochs,
        batchSize,
        dataPath,
        modelDir,
      };
    },
  },
  {
    name: "training_status",
    description:
      "Check if a training run is currently in progress. Returns running state, PID, start time, and tail of training log.",
    inputSchema: z.object({}),
    handler: () => {
      const running = trainingProcess !== null && trainingProcess.exitCode === null;
      return {
        running,
        pid: trainingProcess?.pid ?? null,
        startTime: trainingStartTime,
        logTail: trainingLog.slice(-30), // Last 30 lines
      };
    },
  },
  {
    name: "training_stop",
    description:
      "Stop an in-progress training run by sending SIGTERM to the training process.",
    inputSchema: z.object({}),
    handler: () => {
      if (!trainingProcess || trainingProcess.exitCode !== null) {
        return { stopped: false, reason: "No training in progress" };
      }
      const pid = trainingProcess.pid;
      trainingProcess.kill("SIGTERM");
      trainingLog.push(`[system] Training process (PID: ${pid}) killed via SIGTERM`);
      trainingProcess = null;
      trainingStartTime = null;
      return { stopped: true, pid };
    },
  },
];
