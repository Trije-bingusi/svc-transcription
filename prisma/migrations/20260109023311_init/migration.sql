-- CreateTable
CREATE TABLE "TranscriptionJob" (
    "id" UUID NOT NULL,
    "lecture_id" UUID NOT NULL,
    "video_url" TEXT NOT NULL,
    "video_blob_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "language" TEXT NOT NULL DEFAULT 'sl',
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "transcript_json_blob" TEXT,
    "transcript_vtt_blob" TEXT,
    "transcript_json_url" TEXT,
    "transcript_vtt_url" TEXT,
    "user_id" UUID,

    CONSTRAINT "TranscriptionJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranscriptionJob_lecture_id_idx" ON "TranscriptionJob"("lecture_id");

-- CreateIndex
CREATE INDEX "TranscriptionJob_video_blob_name_idx" ON "TranscriptionJob"("video_blob_name");
