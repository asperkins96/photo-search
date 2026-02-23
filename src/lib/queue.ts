import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

export const photoQueue = new Queue("photo", { connection });

export async function enqueueProcessPhoto(photoId: string) {
  await photoQueue.add("process", { photoId }, { attempts: 3, jobId: photoId, removeOnComplete: 500, removeOnFail: 1000 });
}
