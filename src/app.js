import express from "express";
import client from "prom-client";
import YAML from "yamljs";
import { PrismaClient } from "@prisma/client";
import { apiReference } from "@scalar/express-api-reference";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger, httpLogger } from "./logging.js";
import { initializeBlobServiceClient, uploadBlob, generateSasUrl } from "./azureStorage.js";

function env(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    if (fallback === undefined) throw new Error(`Missing env: ${name}`);
    return fallback;
  }
  return raw;
}

const PORT = Number(env("PORT", "3000"));
env("DATABASE_URL");

const PYTHON_BIN = env("PYTHON_BIN", "python3"); 
const TRANSCRIBE_SCRIPT = env("TRANSCRIBE_SCRIPT", "src/transcribe.py");
const WHISPER_MODEL_ID = env("WHISPER_MODEL_ID", "small");
const WORKER_POLL_MS = Number(env("WORKER_POLL_MS", "2000"));

const AZURE_STORAGE_ACCOUNT_NAME = env("AZURE_STORAGE_ACCOUNT_NAME");
const AZURE_STORAGE_CONTAINER_NAME = env("AZURE_STORAGE_CONTAINER_NAME");
const blobServiceClient = initializeBlobServiceClient(AZURE_STORAGE_ACCOUNT_NAME);

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use(httpLogger);

// Docs
const openapi = YAML.load("./openapi.yaml");
app.get("/docs/transcriptions/openapi.json", (_req, res) => res.json(openapi));
app.use(
  "/docs/transcriptions",
  apiReference({ url: "/docs/transcriptions/openapi.json", theme: "default", darkMode: true })
);

// Metrics
client.collectDefaultMetrics();
const jobCreated = new client.Counter({ name: "svc_transcription_job_created_total", help: "Jobs created" });
const jobDone = new client.Counter({ name: "svc_transcription_job_done_total", help: "Jobs done" });
const jobFailed = new client.Counter({ name: "svc_transcription_job_failed_total", help: "Jobs failed" });

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

// Health
app.get("/healthz", (_req, res) => res.send("OK"));
app.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.send("READY");
  } catch {
    res.status(500).send("NOT READY");
  }
});

// ---------- API ----------
// POST /api/transcriptions
// Body:
// {
//   lecture_id,
//   video_url,                (SAS READ for download)
//   video_blob_name,          (blob name, e.g. "abc.mp4")
//   json_upload_url,          (SAS PUT to upload transcript json)
//   vtt_upload_url,           (SAS PUT to upload transcript vtt)
//   language?                 ("sl")
// }
// ---------- API ----------
// POST /api/transcriptions
app.post("/api/transcriptions", async (req, res, next) => {
  try {
    const {
      lecture_id,
      video_url,
      video_blob_name,
      language = "sl",
    } = req.body || {};

    if (!lecture_id || !video_url || !video_blob_name) {
      return res.status(400).json({
        error: "lecture_id, video_url, video_blob_name are required",
      });
    }

    const existing = await prisma.transcriptionJob.findFirst({
      where: { video_blob_name },
      orderBy: { created_at: "desc" },
      select: { id: true, status: true },
    });
    if (existing) {
      return res.status(202).json({ job_id: existing.id, status: existing.status });
    }

    const base = randomUUID();
    const jsonBlob = base + ".json";
    const vttBlob = base + ".vtt";

    const job = await prisma.transcriptionJob.create({
      data: {
        lecture_id,
        video_url,
        video_blob_name,
        status: "queued",
        language,
        transcript_json_blob: jsonBlob,
        transcript_vtt_blob: vttBlob
      },
      select: { id: true, status: true },
    });

    jobCreated.inc();
    res.status(202).json({ job_id: job.id, status: job.status });
  } catch (err) {
    next(err);
  }
});

// GET /api/transcriptions/:jobId
app.get("/api/transcriptions/:jobId", async (req, res, next) => {
  try {
    const job = await prisma.transcriptionJob.findUnique({ where: { id: req.params.jobId } });
    if (!job) return res.status(404).json({ error: "Not found" });

    res.json({
      job_id: job.id,
      lecture_id: job.lecture_id,
      status: job.status,
      error: job.status === "failed" ? job.error : undefined,

      transcript_json_blob: job.status === "done" ? job.transcript_json_blob : undefined,
      transcript_vtt_blob: job.status === "done" ? job.transcript_vtt_blob : undefined,

      video_blob_name: job.video_blob_name
    });
  } catch (err) {
    next(err);
  }
});

// GET transcription for a lecture
app.get("/api/lectures/:lectureId/transcription", async (req, res, next) => {
  try {
    const lectureId = req.params.lectureId;
    const job = await prisma.transcriptionJob.findFirst({
      where: { lecture_id: lectureId, status: "done" },
      orderBy: { completed_at: "desc" },
    });
    if (!job) return res.status(404).json({ error: "Not found" });

    const sasUrlJson = await generateSasUrl(blobServiceClient, AZURE_STORAGE_CONTAINER_NAME, job.transcript_json_blob);
    const sasUrlVtt = await generateSasUrl(blobServiceClient, AZURE_STORAGE_CONTAINER_NAME, job.transcript_vtt_blob);

    res.json({
      transcript_json_url: sasUrlJson,
      transcript_vtt_url: sasUrlVtt,
    });

  } catch (err) {
    next(err);
  }
});

// Worker
let busy = false;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });

      reject(
        new Error(
          `Command failed: ${cmd} ${args.join(" ")}\n` +
          `exit=${code}\n` +
          (out ? `--- stdout ---\n${out}\n` : "") +
          (err ? `--- stderr ---\n${err}\n` : "")
        )
      );
    });
  });
}

async function processOneJob() {
  if (busy) return;
  busy = true;

  let currentJobId = null;

  const must = (name, v, jobId) => {
    const s = (v ?? "").toString();
    if (!s.trim()) throw new Error(`Missing ${name} on job ${jobId}`);
    return s.trim();
  };

  try {
    const job = await prisma.transcriptionJob.findFirst({
      where: { status: "queued" },
      orderBy: { created_at: "asc" },
    });
    if (!job) return;

    currentJobId = job.id;

    // Validate/sanitize URLs
    const videoUrl = must("video_url", job.video_url, job.id);

    await prisma.transcriptionJob.update({
      where: { id: job.id },
      data: { status: "processing", started_at: new Date() },
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tx-"));
    const videoPath = path.join(tmpDir, "video");
    const wavPath = path.join(tmpDir, "audio.wav");
    const outJson = path.join(tmpDir, "transcript.json");
    const outVtt = path.join(tmpDir, "transcript.vtt");

    await run("curl", ["-L", "--fail", "-o", videoPath, videoUrl]);

    await run("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);

    await run(PYTHON_BIN, [
      TRANSCRIBE_SCRIPT,
      "--model",
      WHISPER_MODEL_ID,
      "--language",
      job.language || "sl",
      "--input_wav",
      wavPath,
      "--out_json",
      outJson,
      "--out_vtt",
      outVtt,
      "--compute_type",
      "int8",
      "--beam_size",
      "1",
      "--vad_filter",
      "--max_segment_s",
      "6",
    ]);

    await uploadBlob(blobServiceClient, AZURE_STORAGE_CONTAINER_NAME, job.transcript_json_blob, await fs.readFile(outJson), "application/json");
    await uploadBlob(blobServiceClient, AZURE_STORAGE_CONTAINER_NAME, job.transcript_vtt_blob, await fs.readFile(outVtt), "text/vtt");
    
    await prisma.transcriptionJob.update({
      where: { id: job.id },
      data: { status: "done", completed_at: new Date(), error: null },
    });

    jobDone.inc();
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (e) {
    logger.error(e, "Job failed");
    if (currentJobId) {
      await prisma.transcriptionJob.update({
        where: { id: currentJobId },
        data: { status: "failed", completed_at: new Date(), error: String(e?.message || e) },
      });
      jobFailed.inc();
    }
  } finally {
    busy = false;
  }
}

setInterval(processOneJob, WORKER_POLL_MS).unref();

// Error handling
app.use((err, _req, res, _next) => {
  logger.error(err, "Internal server error");
  res.status(500).json({ error: "Internal server error" });
});

// Start + graceful shutdown
const server = app.listen(PORT, () => console.log("Transcription service listening on port", PORT));
function shutdown() {
  console.log("Shutting down server...");
  server.close(async () => {
    try { await prisma.$disconnect(); }
    finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
