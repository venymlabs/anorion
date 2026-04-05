// File upload API routes
import { Hono } from 'hono';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, extname, join } from 'path';
import { createHash } from 'crypto';
import { logger } from '../shared/logger';

const app = new Hono();

const UPLOAD_DIR = resolve(process.cwd(), './data/uploads');
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_EXTENSIONS = new Set([
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp',
  // Documents
  '.pdf', '.txt', '.md', '.csv', '.json', '.xml', '.html',
  // Audio
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm',
  // Archives
  '.zip', '.tar', '.gz',
]);

function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

interface UploadResult {
  id: string;
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
  url: string;
  createdAt: string;
}

app.post('/api/v1/upload', async (c) => {
  ensureUploadDir();

  const maxFileSize = DEFAULT_MAX_FILE_SIZE;

  try {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file) {
      return c.json({ error: 'file field is required' }, 400);
    }

    if (!(file instanceof File)) {
      return c.json({ error: 'file must be a file upload' }, 400);
    }

    if (file.size > maxFileSize) {
      return c.json({ error: `File too large. Max size: ${maxFileSize / 1024 / 1024}MB` }, 413);
    }

    const originalName = file.name;
    const ext = extname(originalName).toLowerCase();

    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      return c.json({ error: `File type not allowed: ${ext}` }, 415);
    }

    // Generate unique filename
    const id = createHash('sha256')
      .update(`${Date.now()}-${originalName}-${Math.random()}`)
      .digest('hex')
      .slice(0, 16);

    const filename = ext ? `${id}${ext}` : id;
    const filePath = join(UPLOAD_DIR, filename);

    const arrayBuffer = await file.arrayBuffer();
    writeFileSync(filePath, Buffer.from(arrayBuffer));

    const result: UploadResult = {
      id,
      filename,
      originalName,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      url: `/uploads/${filename}`,
      createdAt: new Date().toISOString(),
    };

    logger.info({ filename, originalName, size: file.size }, 'File uploaded');

    return c.json({ file: result }, 201);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Upload failed');
    return c.json({ error: 'Upload failed' }, 500);
  }
});

export default app;
export { UPLOAD_DIR };
