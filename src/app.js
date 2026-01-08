import express from "express";
import client from "prom-client";
import pinoHttp from "pino-http";
import YAML from "yamljs";
import { PrismaClient } from "@prisma/client";
import { apiReference } from "@scalar/express-api-reference";
import {
  createBatchTranscription,
  getTranscriptionStatus,
  getTranscriptionFiles,
  downloadTranscriptionResult,
  parseTranscriptionResult,
} from "./azureSpeech.js";

function env(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === undefined) {
      throw new Error(`Missing env: ${name}`);
    }
    return fallback;
  }
  return raw;
}

const PORT = Number(env("PORT", "3000"));
const DATABASE_URL = env(
  "DATABASE_URL",
  "postgres://postgres:postgres@localhost:5432/transcription"
);

// Azure Speech Services configuration
const AZURE_SPEECH_KEY = env("AZURE_SPEECH_KEY", "");
const AZURE_SPEECH_REGION = env("AZURE_SPEECH_REGION", "");
const USE_AZURE_SPEECH = AZURE_SPEECH_KEY !== "" && AZURE_SPEECH_REGION !== "";

const prisma = new PrismaClient();

const app = express();
app.use(express.json());

// Scalar API reference
const openapi = YAML.load("./openapi.yaml");
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use(
  "/docs",
  apiReference({
    spec: { url: "/openapi.json" },
    theme: "default",
    darkMode: true,
  })
);

app.use(pinoHttp());

// Prometheus metrics
client.collectDefaultMetrics();
const transcriptionCreatedCounter = new client.Counter({
  name: "svc_transcription_job_created_total",
  help: "Total number of transcription jobs created",
});

const transcriptionCompletedCounter = new client.Counter({
  name: "svc_transcription_job_completed_total",
  help: "Total number of transcription jobs completed",
});

const transcriptionFailedCounter = new client.Counter({
  name: "svc_transcription_job_failed_total",
  help: "Total number of transcription jobs failed",
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

// Health endpoints
app.get("/healthz", (_req, res) => res.send("OK"));
app.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.send("READY");
  } catch {
    res.status(500).send("NOT READY");
  }
});

// Helper function to convert word timings to VTT format
function generateVTT(wordTimings) {
  if (!wordTimings || wordTimings.length === 0) {
    return null;
  }

  let vtt = "WEBVTT\n\n";
  
  // Group words into cues (every 10 words or 5 seconds)
  const cueLength = 10;
  for (let i = 0; i < wordTimings.length; i += cueLength) {
    const cueWords = wordTimings.slice(i, i + cueLength);
    const start = cueWords[0].start;
    const end = cueWords[cueWords.length - 1].end;
    const text = cueWords.map(w => w.word).join(" ");
    
    vtt += `${formatTime(start)} --> ${formatTime(end)}\n`;
    vtt += `${text}\n\n`;
  }
  
  return vtt;
}

// Helper function to convert word timings to SRT format
function generateSRT(wordTimings) {
  if (!wordTimings || wordTimings.length === 0) {
    return null;
  }

  let srt = "";
  let cueIndex = 1;
  
  // Group words into cues (every 10 words or 5 seconds)
  const cueLength = 10;
  for (let i = 0; i < wordTimings.length; i += cueLength) {
    const cueWords = wordTimings.slice(i, i + cueLength);
    const start = cueWords[0].start;
    const end = cueWords[cueWords.length - 1].end;
    const text = cueWords.map(w => w.word).join(" ");
    
    srt += `${cueIndex}\n`;
    srt += `${formatTimeSRT(start)} --> ${formatTimeSRT(end)}\n`;
    srt += `${text}\n\n`;
    cueIndex++;
  }
  
  return srt;
}

// Format time for VTT (HH:MM:SS.mmm)
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

// Format time for SRT (HH:MM:SS,mmm)
function formatTimeSRT(seconds) {
  return formatTime(seconds).replace(".", ",");
}

// Helper function to process transcription with Azure Speech Services
async function transcribeWithAzure(videoUrl, language, transcriptionId) {
  try {
    // Create batch transcription job
    const jobResult = await createBatchTranscription(
      AZURE_SPEECH_KEY,
      AZURE_SPEECH_REGION,
      videoUrl,
      language,
      `Transcription-${transcriptionId}`
    );

    const transcriptionUrl = jobResult.self;
    
    // Store the Azure job ID
    await prisma.transcription.update({
      where: { id: transcriptionId },
      data: { azure_job_id: jobResult.id },
    });

    // Poll for completion (in production, use webhooks)
    let status = "NotStarted";
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes with 5-second intervals

    while (status !== "Succeeded" && status !== "Failed" && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      const statusResult = await getTranscriptionStatus(AZURE_SPEECH_KEY, transcriptionUrl);
      status = statusResult.status;
      attempts++;

      if (status === "Failed") {
        throw new Error(statusResult.error?.message || "Transcription failed");
      }
    }

    if (status !== "Succeeded") {
      throw new Error("Transcription timeout");
    }

    // Get transcription files
    const filesResult = await getTranscriptionFiles(AZURE_SPEECH_KEY, transcriptionUrl);
    
    // Find the transcription result file
    const resultFile = filesResult.values.find(f => f.kind === "Transcription");
    if (!resultFile) {
      throw new Error("No transcription result file found");
    }

    // Download and parse result
    const azureResult = await downloadTranscriptionResult(AZURE_SPEECH_KEY, resultFile.links.contentUrl);
    const { transcript, wordTimings, confidence } = parseTranscriptionResult(azureResult);

    return { transcript, wordTimings, confidence };
  } catch (error) {
    console.error("Azure transcription error:", error);
    throw error;
  }
}

// Transcription endpoints

// Get all transcriptions for a lecture
app.get("/api/lectures/:lectureId/transcriptions", async (req, res) => {
  try {
    const { lectureId } = req.params;
    const transcriptions = await prisma.transcription.findMany({
      where: { lecture_id: lectureId },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        lecture_id: true,
        video_url: true,
        language: true,
        status: true,
        confidence: true,
        duration: true,
        created_at: true,
        updated_at: true,
        completed_at: true,
      },
    });
    res.json(transcriptions);
  } catch (error) {
    req.log.error(error, "Failed to fetch transcriptions");
    res.status(500).json({ error: "Failed to fetch transcriptions" });
  }
});

// Get specific transcription
app.get("/api/transcriptions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const transcription = await prisma.transcription.findUnique({
      where: { id },
    });
    if (!transcription) {
      return res.status(404).json({ error: "Transcription not found" });
    }
    res.json(transcription);
  } catch (error) {
    req.log.error(error, "Failed to fetch transcription");
    res.status(500).json({ error: "Failed to fetch transcription" });
  }
});

// Get transcript text only
app.get("/api/transcriptions/:id/transcript", async (req, res) => {
  try {
    const { id } = req.params;
    const transcription = await prisma.transcription.findUnique({
      where: { id },
      select: { transcript: true, status: true },
    });
    if (!transcription) {
      return res.status(404).json({ error: "Transcription not found" });
    }
    if (transcription.status !== "completed") {
      return res.status(400).json({ error: "Transcription not yet completed" });
    }
    res.json({ transcript: transcription.transcript });
  } catch (error) {
    req.log.error(error, "Failed to fetch transcript");
    res.status(500).json({ error: "Failed to fetch transcript" });
  }
});

// Get VTT subtitles
app.get("/api/transcriptions/:id/vtt", async (req, res) => {
  try {
    const { id } = req.params;
    const transcription = await prisma.transcription.findUnique({
      where: { id },
      select: { vtt_content: true, status: true },
    });
    if (!transcription) {
      return res.status(404).json({ error: "Transcription not found" });
    }
    if (transcription.status !== "completed") {
      return res.status(400).json({ error: "Transcription not yet completed" });
    }
    res.setHeader("Content-Type", "text/vtt");
    res.send(transcription.vtt_content);
  } catch (error) {
    req.log.error(error, "Failed to fetch VTT");
    res.status(500).json({ error: "Failed to fetch VTT" });
  }
});

// Get SRT subtitles
app.get("/api/transcriptions/:id/srt", async (req, res) => {
  try {
    const { id } = req.params;
    const transcription = await prisma.transcription.findUnique({
      where: { id },
      select: { srt_content: true, status: true },
    });
    if (!transcription) {
      return res.status(404).json({ error: "Transcription not found" });
    }
    if (transcription.status !== "completed") {
      return res.status(400).json({ error: "Transcription not yet completed" });
    }
    res.setHeader("Content-Type", "text/plain");
    res.send(transcription.srt_content);
  } catch (error) {
    req.log.error(error, "Failed to fetch SRT");
    res.status(500).json({ error: "Failed to fetch SRT" });
  }
});

// Create new transcription job
app.post("/api/lectures/:lectureId/transcribe", async (req, res) => {
  try {
    const { lectureId } = req.params;
    const { video_url, language = "en-US" } = req.body;

    if (!video_url) {
      return res.status(400).json({ error: "video_url is required" });
    }

    // Create transcription record
    const transcription = await prisma.transcription.create({
      data: {
        lecture_id: lectureId,
        video_url,
        language,
        status: "pending",
      },
    });

    transcriptionCreatedCounter.inc();

    req.log.info(
      { transcriptionId: transcription.id, lectureId, videoUrl: video_url },
      "Transcription job created"
    );

    // Start async transcription (in production, this would be a background job)
    processTranscription(transcription.id, video_url, language).catch((error) => {
      console.error("Background transcription failed:", error);
    });

    res.status(201).json(transcription);
  } catch (error) {
    req.log.error(error, "Failed to create transcription job");
    res.status(500).json({ error: "Failed to create transcription job" });
  }
});

// Background transcription processor
async function processTranscription(transcriptionId, videoUrl, language) {
  try {
    // Update status to processing
    await prisma.transcription.update({
      where: { id: transcriptionId },
      data: { status: "processing" },
    });

    if (!USE_AZURE_SPEECH) {
      // Mock transcription for local development
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      const mockTranscript = "This is a mock transcription for local development. Azure Speech Services is not configured.";
      const mockWordTimings = [
        { word: "This", start: 0.0, end: 0.3, confidence: 0.98 },
        { word: "is", start: 0.3, end: 0.5, confidence: 0.99 },
        { word: "a", start: 0.5, end: 0.6, confidence: 0.99 },
        { word: "mock", start: 0.6, end: 0.9, confidence: 0.97 },
        { word: "transcription", start: 0.9, end: 1.5, confidence: 0.96 },
      ];

      await prisma.transcription.update({
        where: { id: transcriptionId },
        data: {
          status: "completed",
          transcript: mockTranscript,
          word_timings: mockWordTimings,
          vtt_content: generateVTT(mockWordTimings),
          srt_content: generateSRT(mockWordTimings),
          confidence: 0.98,
          duration: 120,
          completed_at: new Date(),
        },
      });

      transcriptionCompletedCounter.inc();
      return;
    }

    // Actual Azure transcription
    const result = await transcribeWithAzure(videoUrl, language, transcriptionId);
    
    const duration = result.wordTimings.length > 0
      ? Math.ceil(result.wordTimings[result.wordTimings.length - 1].end)
      : null;

    await prisma.transcription.update({
      where: { id: transcriptionId },
      data: {
        status: "completed",
        transcript: result.transcript,
        word_timings: result.wordTimings,
        vtt_content: generateVTT(result.wordTimings),
        srt_content: generateSRT(result.wordTimings),
        confidence: result.confidence,
        duration,
        completed_at: new Date(),
      },
    });

    transcriptionCompletedCounter.inc();
  } catch (error) {
    console.error("Transcription processing error:", error);
    
    await prisma.transcription.update({
      where: { id: transcriptionId },
      data: {
        status: "failed",
        error_message: error.message,
      },
    });

    transcriptionFailedCounter.inc();
  }
}

// Delete transcription
app.delete("/api/transcriptions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.transcription.delete({
      where: { id },
    });

    res.json({ message: "Transcription deleted successfully" });
  } catch (error) {
    req.log.error(error, "Failed to delete transcription");
    res.status(500).json({ error: "Failed to delete transcription" });
  }
});

app.listen(PORT, () => {
  console.log(`svc-transcription listening on port ${PORT}`);
  console.log(`API docs available at http://localhost:${PORT}/docs`);
  console.log(`Azure Speech Services: ${USE_AZURE_SPEECH ? "enabled" : "disabled (mock mode)"}`);
});
