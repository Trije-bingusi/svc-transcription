import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Azure Blob Storage helper functions
 */

export function initializeBlobServiceClient(storageAccount) {
  const credential = new DefaultAzureCredential();
  const accountUrl = `https://${storageAccount}.blob.core.windows.net`;
  return new BlobServiceClient(accountUrl, credential);
}

/**
 * Generate a SAS URL for secure blob access
 * @param {BlobServiceClient} blobServiceClient
 * @param {string} containerName
 * @param {string} blobName
 * @param {number} expiresInMinutes - How long the SAS token is valid (default: 60 minutes)
 * @param {boolean} writePermission - If true, grants write permission; otherwise read-only
 * @returns {Promise<string>} The blob URL with SAS token
 */
export async function generateSasUrl(blobServiceClient, containerName, blobName, expiresInMinutes = 60, writePermission = false) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  const accountName = blobServiceClient.accountName;
  const permissions = writePermission ? BlobSASPermissions.parse("cw") : BlobSASPermissions.parse("r");
  
  // For development with connection strings, extract the key
  if (blobServiceClient.credential instanceof StorageSharedKeyCredential) {
    const startsOn = new Date();
    const expiresOn = new Date(startsOn.getTime() + expiresInMinutes * 60 * 1000);

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions,
        startsOn,
        expiresOn,
      },
      blobServiceClient.credential
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } else {
    // For managed identity, use user delegation SAS
    const startsOn = new Date();
    const expiresOn = new Date(startsOn.getTime() + expiresInMinutes * 60 * 1000);

    const userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions,
        startsOn,
        expiresOn,
      },
      userDelegationKey,
      accountName
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  }
}

/**
 * Delete a blob from storage
 */
export async function deleteBlob(blobServiceClient, containerName, blobName) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.deleteIfExists();
}

/**
 * Upload a blob to storage
 */
export async function uploadBlob(blobServiceClient, containerName, blobName, buffer, mimeType) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  
  // Ensure container exists
  await containerClient.createIfNotExists();

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  // Upload buffer to blob
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: mimeType,
    },
  });

  return blockBlobClient.url;
}

export async function pollBlobUploadStatus(blobServiceClient, containerName, blobNames) {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const existingBlobs = new Set();
  for (const blobName of blobNames) {
    const blobClient = containerClient.getBlobClient(blobName);
    const exists = await blobClient.exists();
    if (exists) {
      existingBlobs.add(blobName);
    }
  }
  return existingBlobs;
}