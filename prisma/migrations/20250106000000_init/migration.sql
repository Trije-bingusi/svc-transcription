-- CreateEnum
DO $$ BEGIN
 CREATE TYPE "TranscriptionStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Transcription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lecture_id" UUID NOT NULL,
    "video_url" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "azure_job_id" TEXT,
    "transcript" TEXT,
    "word_timings" JSONB,
    "vtt_content" TEXT,
    "srt_content" TEXT,
    "error_message" TEXT,
    "duration" INTEGER,
    "confidence" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "Transcription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Transcription_lecture_id_idx" ON "Transcription"("lecture_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Transcription_status_idx" ON "Transcription"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Transcription_azure_job_id_key" ON "Transcription"("azure_job_id");
