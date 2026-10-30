import { DatabaseQueries, Attachment } from '../db/queries';
import { generateId, sanitizeFilename } from './utils';

/**
 * Attachment storage: R2 when the ATTACHMENTS bucket is bound, inline
 * base64 in D1 otherwise. Reads handle both so legacy rows keep working.
 */

// D1 rows are size-limited; R2 objects are not (we cap generously)
export const MAX_INLINE_ATTACHMENT_SIZE = 5 * 1024 * 1024;   // 5MB in D1
export const MAX_R2_ATTACHMENT_SIZE = 25 * 1024 * 1024;      // 25MB in R2

export function maxAttachmentSize(bucket: R2Bucket | undefined): number {
  return bucket ? MAX_R2_ATTACHMENT_SIZE : MAX_INLINE_ATTACHMENT_SIZE;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Persist attachment bytes and its metadata row.
 */
export async function storeAttachment(
  db: DatabaseQueries,
  bucket: R2Bucket | undefined,
  input: {
    emailId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }
): Promise<string> {
  const id = generateId();
  const filename = sanitizeFilename(input.filename);

  if (bucket) {
    const key = `attachments/${input.emailId}/${id}`;
    await bucket.put(key, input.bytes.slice().buffer, {
      httpMetadata: { contentType: input.contentType },
    });
    await db.createAttachment({
      id,
      email_id: input.emailId,
      filename,
      content_type: input.contentType,
      size: input.bytes.byteLength,
      content: null,
      r2_key: key,
    });
  } else {
    await db.createAttachment({
      id,
      email_id: input.emailId,
      filename,
      content_type: input.contentType,
      size: input.bytes.byteLength,
      content: uint8ToBase64(input.bytes),
      r2_key: null,
    });
  }

  return id;
}

/**
 * Load attachment bytes from wherever they live.
 */
export async function loadAttachmentBytes(
  bucket: R2Bucket | undefined,
  attachment: Pick<Attachment, 'content' | 'r2_key'>
): Promise<Uint8Array | null> {
  if (attachment.r2_key && bucket) {
    const object = await bucket.get(attachment.r2_key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }
  if (attachment.content) {
    return base64ToUint8(attachment.content);
  }
  return null;
}

export async function loadAttachmentBase64(
  bucket: R2Bucket | undefined,
  attachment: Pick<Attachment, 'content' | 'r2_key'>
): Promise<string | null> {
  if (attachment.content) return attachment.content;
  const bytes = await loadAttachmentBytes(bucket, attachment);
  return bytes ? uint8ToBase64(bytes) : null;
}

/**
 * Delete the R2 objects belonging to an email's attachments (row deletion
 * happens separately in D1). Safe to call without a bucket.
 */
export async function deleteAttachmentObjects(
  bucket: R2Bucket | undefined,
  attachments: Array<Pick<Attachment, 'r2_key'>>
): Promise<void> {
  if (!bucket) return;
  const keys = attachments.map(a => a.r2_key).filter((k): k is string => !!k);
  if (keys.length > 0) {
    await bucket.delete(keys);
  }
}

// ==================== Base64 helpers shared by the UI and the mail API ====================

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function base64ToBytes(content: string): Uint8Array {
  return base64ToUint8(content);
}

/** Decoded size, without materialising the bytes. */
export function base64ByteLength(content: string): number {
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  return Math.floor((content.length * 3) / 4) - padding;
}

export function isValidBase64(content: string): boolean {
  return content.length % 4 === 0 && BASE64_PATTERN.test(content);
}

export interface AttachmentLimits {
  perFile: number;
  total: number;
  count: number;
}

export interface OutgoingAttachment {
  filename?: string;
  content?: string;
  content_type?: string;
  contentType?: string;
}

/**
 * Validate a caller-supplied attachment list. Shared so the web UI and the
 * public API can never disagree about what is accepted.
 */
export function validateOutgoingAttachments(
  attachments: unknown,
  limits: AttachmentLimits,
  isAllowedType: (contentType: string) => boolean
): string | null {
  if (attachments === undefined || attachments === null) return null;
  if (!Array.isArray(attachments)) return 'attachments must be an array';
  if (attachments.length > limits.count) return `Too many attachments (max ${limits.count})`;

  let totalSize = 0;
  for (const raw of attachments as OutgoingAttachment[]) {
    const filename = typeof raw?.filename === 'string' ? raw.filename.trim() : '';
    const content = typeof raw?.content === 'string' ? raw.content : '';
    if (!filename || !content) return 'Each attachment needs filename and content';
    if (!isValidBase64(content)) return `Attachment "${filename}" is not valid base64`;

    const contentType = raw.content_type ?? raw.contentType;
    if (contentType && !isAllowedType(contentType)) return `Attachment type not allowed: ${contentType}`;

    const size = base64ByteLength(content);
    if (size > limits.perFile) return `Attachment "${filename}" exceeds ${Math.round(limits.perFile / 1024 / 1024)}MB`;
    totalSize += size;
  }

  if (totalSize > limits.total) return `Total attachment size exceeds ${Math.round(limits.total / 1024 / 1024)}MB`;
  return null;
}

