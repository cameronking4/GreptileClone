import logger from "@/lib/logger";
import { v4 as uuidv4 } from "uuid";
import { kv } from "@vercel/kv";
import type { NextRequest } from "next/server";
import type { FileInfo, Job } from "@/lib/types";
import { fetchFiles, getFileType } from "@/lib";
import dotenv from "dotenv";
dotenv.config();

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GH_PAT = process.env.GITHUB_TOKEN;
logger.info("queue env variables", process.env);
export async function POST(req: NextRequest) {
  try {
    const { owner, repo } = await req.json();
    logger.info(`Queuing AST generation jobs for ${owner}/${repo}...`);
    const groupId = await queueGroupedJobs(owner, repo);
    logger.info(`AST generation jobs queued successfully`, { groupId });
    return new Response(JSON.stringify({ success: true, groupId }));
  } catch (error: any) {
    logger.error(error.message);
    return new Response(error, { status: 500 });
  }
}

async function queueGroupedJobs(owner: string, repo: string): Promise<string> {
  logger.info(`queueGroupedJobs`, { owner, repo });
  const repoKey = `${owner}/${repo}`;
  const files = (await fetchFiles(owner, repo)).filter(
    (fileInfo: FileInfo) => getFileType(fileInfo.path) !== "Media",
  );

  const groupId = uuidv4();
  const jobs: Job[] = [];

  for (const file of files) {
    const latestMetadata = await fetchGitHubCommits(repoKey, file.path);
    const storedMetadata = await getFileMetadata(repoKey, file.path);

    if (!storedMetadata || storedMetadata.sha !== latestMetadata[0].sha) {
      const job: Job = {
        id: uuidv4(),
        file,
        groupId,
        status: "queued" as Job["status"],
        owner,
        repo,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.push(job);
      await queueJob(job);
      await storeFileMetadata(repoKey, file.path, latestMetadata[0]);
    }
  }
  logger.info(`queueGroupedJobs result`, { groupId, jobs });
  return groupId;
}

async function queueJob(job: Job): Promise<void> {
  logger.info(`queueJob`, { job });
  await kv.set(`job:${job.id}`, JSON.stringify(job));
  await kv.set(`group:${job.groupId}:${job.id}`, "queued");
  logger.info(`queueJob completed`, { jobId: job.id });
}

async function fetchGitHubCommits(repo: string, path: string): Promise<any> {
  logger.info(`fetchGitHubCommits`, { repo, path });
  const url = `https://api.github.com/repos/${repo}/commits?path=${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${GH_PAT}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  const data = await response.json();
  logger.info(`fetchGitHubCommits result`, { data });
  return data;
}

async function storeFileMetadata(
  repo: string,
  file: string,
  metadata: any = {},
): Promise<void> {
  logger.info(`storeFileMetadata`, { repo, file, metadata });
  await kv.set(`${repo}:${file}:metadata`, JSON.stringify(metadata));
  logger.info(`storeFileMetadata completed`, { repo, file });
}

async function getFileMetadata(repo: string, file: string): Promise<any> {
  const key = `${repo}:${file}:metadata`;
  logger.info(`getFileMetadata`, { repo, file });
  const result = (await kv.get<string>(key)) ?? {};
  logger.info(`getFileMetadata result`, { result });
  return result;
}

// async function generateASTsForRepo(
//   owner: string,
//   repo: string,
// ): Promise<string> {
//   const metadata = await fetchRepoMetadata(owner, repo);
//   const files = await fetchFiles(owner, repo);
//   const asts = await generateASTsForFiles(files);
//
//   const repoAST = {
//     metadata: metadata,
//     files: asts,
//   };
//
//   const filename = getASTFilename(owner, repo);
//   saveASTsToFile(filename, repoAST);
//   logger.info(`ASTs for ${repo} have been saved to ${filename}.`);
//   return filename;
// }

// async function generateASTsForFiles(files: FileInfo[]): Promise<AST[]> {
//   const asts = [];
//   for (const file of files) {
//     if (getFileType(file.path) !== "Media") {
//       const astData = await fileInfoToAstData(file);
//       asts.push(astData);
//     }
//   }
//   return asts;
// }
