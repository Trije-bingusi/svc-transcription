# svc-transcription

Microservice for video transcription using **Azure AI Speech Services** for the _eUčilnica+_ platform.

## Overview

This service handles:

- **Video transcription** using Azure AI Speech Services
- **Speech-to-text** conversion with word-level timing
- **Subtitle generation** in VTT and SRT formats
- **Multi-language support** (configurable per transcription)
- **Background job processing** for async transcription
- **Prometheus metrics** for monitoring
- **Health and readiness checks**

## Architecture

```
Client → svc-gateway → svc-transcription → Azure Speech Services
                    ↓
                PostgreSQL
```

The service stores transcription metadata and results in PostgreSQL and uses Azure Speech Services for the actual transcription processing.

## Tech Stack

- **Node.js 22** + **Express**
- **Prisma** ORM with PostgreSQL
- **Azure SDK**:
  - `microsoft-cognitiveservices-speech-sdk` for Speech-to-Text
  - `@azure/ai-language-text` for text analysis (optional)
- **Prometheus** metrics via `prom-client`
- **Scalar** for API documentation
- **Docker** for containerization

## Getting Started

### Prerequisites

- Node.js 22+
- PostgreSQL 16+
- Azure Speech Services resource (for production)
- Docker & Docker Compose (optional)

### Environment Variables

Create a `.env` file:

```bash
# Server
PORT=3000

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/transcription

# Azure Speech Services
AZURE_SPEECH_KEY=your-speech-services-key
AZURE_SPEECH_REGION=westeurope
```

**For local development**, you can leave Azure variables empty. The service will run in mock mode and generate sample transcriptions.

### Installation

```bash
npm install
```

### Database Setup

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate:dev
```

### Running Locally

```bash
npm start
```

The service will be available at `http://localhost:3000`.

### Running with Docker

```bash
docker compose up --build
```

This starts both the service and a PostgreSQL database.

## API Endpoints

### Health & Monitoring

- `GET /healthz` – liveness check
- `GET /readyz` – readiness check (verifies DB connection)
- `GET /metrics` – Prometheus metrics
- `GET /docs` – Scalar API documentation
- `GET /openapi.json` – OpenAPI specification

### Transcription Jobs

#### Get transcriptions for a lecture

```http
GET /api/lectures/:lectureId/transcriptions
```

Returns all transcription jobs for a specific lecture.

#### Create transcription job

```http
POST /api/lectures/:lectureId/transcribe
Content-Type: application/json

{
  "video_url": "https://example.blob.core.windows.net/videos/lecture1.mp4",
  "language": "en-US"
}
```

Creates a new transcription job. The service will process the video in the background.

**Supported languages** (examples):
- `en-US` – English (United States)
- `en-GB` – English (United Kingdom)
- `sl-SI` – Slovenian (Slovenia)
- `de-DE` – German (Germany)
- `fr-FR` – French (France)

See [Azure Speech Services documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support) for the full list.

**Response:**
```json
{
  "id": "uuid",
  "lecture_id": "lecture-uuid",
  "video_url": "https://...",
  "language": "en-US",
  "status": "pending",
  "created_at": "2026-01-06T12:00:00Z"
}
```

#### Get specific transcription

```http
GET /api/transcriptions/:id
```

Returns full details including word timings (if completed).

#### Get transcript text only

```http
GET /api/transcriptions/:id/transcript
```

Returns just the plain text transcript:

```json
{
  "transcript": "This is the full transcript text..."
}
```

#### Get VTT subtitles

```http
GET /api/transcriptions/:id/vtt
```

Returns WebVTT format subtitles suitable for HTML5 video:

```
WEBVTT

00:00:00.000 --> 00:00:02.500
This is the first subtitle

00:00:02.500 --> 00:00:05.000
This is the second subtitle
```

#### Get SRT subtitles

```http
GET /api/transcriptions/:id/srt
```

Returns SubRip (SRT) format subtitles:

```
1
00:00:00,000 --> 00:00:02,500
This is the first subtitle

2
00:00:02,500 --> 00:00:05,000
This is the second subtitle
```

#### Delete transcription

```http
DELETE /api/transcriptions/:id
```

Deletes the transcription job and all associated data.

## Database Schema

```prisma
model Transcription {
  id            String    @id @default(uuid())
  lecture_id    String
  video_url     String
  language      String    @default("en-US")
  status        String    @default("pending")
  azure_job_id  String?   @unique
  transcript    String?
  word_timings  Json?
  vtt_content   String?
  srt_content   String?
  error_message String?
  duration      Int?
  confidence    Float?
  created_at    DateTime  @default(now())
  updated_at    DateTime  @updatedAt
  completed_at  DateTime?
}
```

## Transcription Status Flow

1. **pending** – Job created, waiting to start
2. **processing** – Azure is transcribing the video
3. **completed** – Transcription finished successfully
4. **failed** – Transcription failed (check `error_message`)

## Features

### Word-Level Timing

The service stores word-level timing information as JSON:

```json
[
  { "word": "Hello", "start": 0.0, "end": 0.5, "confidence": 0.98 },
  { "word": "world", "start": 0.5, "end": 1.0, "confidence": 0.99 }
]
```

This enables:
- Precise subtitle generation
- Interactive transcripts with clickable words
- Search within specific time ranges

### Subtitle Generation

Subtitles are automatically generated in both VTT and SRT formats:

- **VTT** (WebVTT) – Modern format for HTML5 `<video>` and `<track>` elements
- **SRT** (SubRip) – Classic format with wide compatibility

Words are grouped into cues (10 words or 5 seconds per cue).

### Confidence Scores

Azure Speech Services provides confidence scores (0-1) for each word. The average confidence is stored for the entire transcription.

## Metrics

The service exposes Prometheus metrics:

- `svc_transcription_job_created_total` – Total transcription jobs created
- `svc_transcription_job_completed_total` – Total jobs completed successfully
- `svc_transcription_job_failed_total` – Total jobs that failed
- Default Node.js metrics (memory, CPU, etc.)

## Azure Integration

### Speech Services

The service uses Azure AI Speech Services for transcription. You'll need:

1. An Azure Speech Services resource
2. The subscription key (`AZURE_SPEECH_KEY`)
3. The region (`AZURE_SPEECH_REGION`, e.g., `westeurope`)

**Authentication:**
```bash
AZURE_SPEECH_KEY=your-key-here
AZURE_SPEECH_REGION=westeurope
```

### Batch Transcription API

For production use with long videos, consider using the [Azure Batch Transcription API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription) which:

- Handles large files (up to 2GB)
- Supports multiple audio channels
- Provides diarization (speaker separation)
- Includes punctuation and formatting

The current implementation uses the simpler real-time API, but can be extended to use batch transcription.

## Development

### Project Structure

```
svc-transcription/
├── src/
│   └── app.js           # Main Express application
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── migrations/      # Database migrations
├── openapi.yaml         # API specification
├── Dockerfile           # Container image
├── docker-compose.yml   # Local development setup
├── package.json
└── README.md
```

### Mock Mode

When Azure credentials are not configured, the service runs in mock mode:

- Generates sample transcriptions after a short delay
- Creates mock word timings
- Useful for local development and testing

### Adding to rso-platform

To integrate this service into the main platform:

1. Create a new Git repository:
   ```bash
   cd svc-transcription
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/Trije-bingusi/svc-transcription.git
   git push -u origin main
   ```

2. Add as submodule in `rso-platform`:
   ```bash
   cd rso-platform
   git submodule add https://github.com/Trije-bingusi/svc-transcription.git
   ```

3. Update `rso-platform/docker-compose.yml` to include this service

4. Update `svc-gateway` to proxy `/api/transcriptions/*` requests to this service

## Integration with Video Upload Service

The transcription service works together with `svc-video-upload`:

1. User uploads a video via `svc-video-upload`
2. Video is stored in Azure Blob Storage
3. `svc-video-upload` returns a `blob_url`
4. Client calls `svc-transcription` with the `blob_url` to start transcription
5. Transcription runs in the background
6. Client polls for status or receives webhook notification when complete
7. Subtitles can be added to the video player

## Troubleshooting

### "Transcription not yet completed"

Transcription is processed asynchronously. Check the `status` field:
- `pending` – waiting to start
- `processing` – in progress
- `completed` – ready to fetch
- `failed` – check `error_message`

### Database connection fails

Check that `DATABASE_URL` is correct and PostgreSQL is running:
```bash
docker compose up db
```

### Azure authentication fails

Verify your Speech Services credentials:
```bash
# Test with Azure CLI
az cognitiveservices account show --name your-speech-service --resource-group your-rg
```

Ensure the key and region are correct in your `.env` file.

### Unsupported language error

Check that the language code is valid. Use BCP-47 format (e.g., `en-US`, `sl-SI`).

See the [full list of supported languages](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support).

## Future Enhancements

- **Real-time transcription** for live lectures
- **Speaker diarization** (identify different speakers)
- **Custom vocabulary** for technical terms
- **Translation** to multiple languages
- **Keyword extraction** and summary generation
- **Sentiment analysis** of lecture content

## License

ISC
