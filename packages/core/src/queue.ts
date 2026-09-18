import { Queue } from 'bullmq';
import { redisUrl } from './config';
export const queueName = 'filemorph-media';
export function connection() {
  const url = new URL(redisUrl());
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
let queue: Queue;
export function mediaQueue() {
  return (queue ||= new Queue(queueName, {
    connection: connection(),
    defaultJobOptions: {
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  }));
}
export const transcriptionQueueName = 'filemorph-transcription';
let speechQueue: Queue;
export function transcriptionQueue() {
  return (speechQueue ||= new Queue(transcriptionQueueName, {
    connection: connection(),
    defaultJobOptions: {
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  }));
}
export function queueForTool(tool: string) {
  if (tool.endsWith('-watermark-remover')) return watermarkQueue();
  if (tool.endsWith('-translator')) return translationQueue();
  return tool === 'transcription' ? transcriptionQueue() : mediaQueue();
}

export const translationQueueName = 'filemorph-translation';
let translateQueue: Queue;
export function translationQueue() {
  return (translateQueue ||= new Queue(translationQueueName, {
    connection: connection(),
    defaultJobOptions: {
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  }));
}
export const readingQueueName = 'filemorph-reading';
let readerQueue: Queue;
export function readingQueue() {
  return (readerQueue ||= new Queue(readingQueueName, {
    connection: connection(),
    defaultJobOptions: {
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  }));
}
export const watermarkQueueName = 'filemorph-watermark';
let wmQueue: Queue;
export function watermarkQueue() {
  return (wmQueue ||= new Queue(watermarkQueueName, {
    connection: connection(),
    defaultJobOptions: {
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  }));
}
