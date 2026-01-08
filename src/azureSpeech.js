import fetch from "node-fetch";

/**
 * Azure Speech Services Batch Transcription Helper
 * Uses the Batch Transcription REST API for video/audio files from URLs
 */

const BATCH_API_VERSION = "2024-05-15-preview";

/**
 * Create a batch transcription job
 * @param {string} speechKey - Azure Speech Services API key
 * @param {string} speechRegion - Azure region (e.g., 'westeurope')
 * @param {string} audioUrl - Publicly accessible URL to the audio/video file
 * @param {string} locale - Language locale (e.g., 'en-US', 'sl-SI')
 * @param {string} displayName - Display name for the transcription job
 * @returns {Promise<object>} Transcription job details
 */
export async function createBatchTranscription(speechKey, speechRegion, audioUrl, locale = "en-US", displayName = "Transcription") {
  const endpoint = `https://${speechRegion}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions`;

  const body = {
    contentUrls: [audioUrl],
    locale,
    displayName,
    properties: {
      wordLevelTimestampsEnabled: true,
      punctuationMode: "DictatedAndAutomatic",
      profanityFilterMode: "Masked",
      diarizationEnabled: false,
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": speechKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create transcription: ${response.status} - ${error}`);
  }

  return await response.json();
}

/**
 * Get transcription status
 * @param {string} speechKey
 * @param {string} transcriptionUrl - The self link from create response
 * @returns {Promise<object>} Transcription status
 */
export async function getTranscriptionStatus(speechKey, transcriptionUrl) {
  const response = await fetch(transcriptionUrl, {
    headers: {
      "Ocp-Apim-Subscription-Key": speechKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get transcription status: ${response.status}`);
  }

  return await response.json();
}

/**
 * Get transcription files (results)
 * @param {string} speechKey
 * @param {string} transcriptionUrl - The self link from create response
 * @returns {Promise<object>} Transcription files
 */
export async function getTranscriptionFiles(speechKey, transcriptionUrl) {
  const filesUrl = `${transcriptionUrl}/files`;
  
  const response = await fetch(filesUrl, {
    headers: {
      "Ocp-Apim-Subscription-Key": speechKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get transcription files: ${response.status}`);
  }

  return await response.json();
}

/**
 * Download and parse transcription result
 * @param {string} speechKey
 * @param {string} resultUrl - URL to the transcription result file
 * @returns {Promise<object>} Parsed transcription data
 */
export async function downloadTranscriptionResult(speechKey, resultUrl) {
  const response = await fetch(resultUrl, {
    headers: {
      "Ocp-Apim-Subscription-Key": speechKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download transcription result: ${response.status}`);
  }

  return await response.json();
}

/**
 * Delete a transcription job
 * @param {string} speechKey
 * @param {string} transcriptionUrl
 */
export async function deleteTranscriptionJob(speechKey, transcriptionUrl) {
  const response = await fetch(transcriptionUrl, {
    method: "DELETE",
    headers: {
      "Ocp-Apim-Subscription-Key": speechKey,
    },
  });

  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to delete transcription: ${response.status}`);
  }
}

/**
 * Parse Azure transcription result into our format
 * @param {object} azureResult - Raw Azure transcription result
 * @returns {object} { transcript, wordTimings, confidence }
 */
export function parseTranscriptionResult(azureResult) {
  const combinedResults = azureResult.combinedRecognizedPhrases || [];
  const recognizedPhrases = azureResult.recognizedPhrases || [];

  // Get full transcript
  const transcript = combinedResults.map(phrase => phrase.display).join(" ");

  // Extract word timings
  const wordTimings = [];
  for (const phrase of recognizedPhrases) {
    if (phrase.nBest && phrase.nBest.length > 0) {
      const best = phrase.nBest[0];
      if (best.words) {
        for (const word of best.words) {
          wordTimings.push({
            word: word.word,
            start: parseFloat(word.offsetInTicks) / 10000000, // Convert ticks to seconds
            end: (parseFloat(word.offsetInTicks) + parseFloat(word.durationInTicks)) / 10000000,
            confidence: parseFloat(word.confidence) || 1.0,
          });
        }
      }
    }
  }

  // Calculate average confidence
  const avgConfidence = wordTimings.length > 0
    ? wordTimings.reduce((sum, w) => sum + w.confidence, 0) / wordTimings.length
    : null;

  return { transcript, wordTimings, confidence: avgConfidence };
}
