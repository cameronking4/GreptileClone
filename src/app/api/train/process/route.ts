import { kv } from "@vercel/kv";
import logger from "@/lib/logger";
import OpenAI from "openai";
import * as fs from "fs-extra";
import babel from "@babel/core";
import postcss from "postcss";
import * as htmlparser2 from "htmlparser2";
import { marked } from "marked";
import dotenv from "dotenv";
import { fetchFile, getFileType } from "@/lib";
import type { AST, AstData, FileInfo, Job, Metadata } from "@/lib/types";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
dotenv.config();

const babelConfig = {
  presets: [
    "@babel/preset-env",
    "@babel/preset-react",
    "@babel/preset-typescript",
  ],
  plugins: [
    "@babel/plugin-syntax-dynamic-import",
    "@babel/plugin-proposal-class-properties",
    "@babel/plugin-proposal-private-methods",
    "@babel/plugin-proposal-nullish-coalescing-operator",
    "@babel/plugin-proposal-optional-chaining",
  ],
};

// Rate limiting setup
const RATE_LIMIT_WINDOW_MS = 1000;
let lastApiCallTime = 0;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const astVectorStoreId = process.env.OPENAI_AST_VECTOR_STORE_ID;

const GH_PAT = process.env.GITHUB_TOKEN;
logger.info("process env variables", process.env);
export async function GET(req: NextRequest) {
  if (
    req.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    logger.info(`Triggering jobs`);
    const jobs = await getJobs("job:*");
    const inProgressJobs = jobs.filter(
      (job: Job) => job.status === "in-progress",
    );
    const staleInProgressJobs = filterForStaleJobs(inProgressJobs, 60_000 * 6);

    if (staleInProgressJobs.length > 0) {
      logger.info(`Processing stale jobs`);
      await processJobs(staleInProgressJobs);
      return new Response(JSON.stringify({ success: true }));
    }

    const queuedJobs = jobs.filter((job: Job) => job.status === "queued");
    if (queuedJobs.length > 0) {
      logger.info(`Processing queued jobs`);
      await processJobs(queuedJobs);
      return new Response(JSON.stringify({ success: true }));
    }

    logger.info(`Nothing to do`);
    return new Response(JSON.stringify({ success: true }));
  } catch (error: any) {
    logger.error(error.message);
    return new Response(error, { status: 500 });
  }
}

async function getJobs(pattern: string): Promise<Job[]> {
  logger.info(`getJobs`, { pattern });
  const jobIds: string[] = [];
  for await (const key of kv.scanIterator({ match: pattern })) {
    jobIds.push(key);
  }
  logger.info(`getJobs`, { jobIds });
  const jobs: Job[] = (await Promise.all(
    jobIds.map(async (key) => (await kv.get(key)) ?? {}),
  )) as Job[];
  logger.info(`getJobs`, { jobs });
  const result = jobs.filter(Boolean).sort((a, b) => a.updatedAt - b.updatedAt);
  logger.info(`getJobs`, { result });
  return result;
}

function filterForStaleJobs(jobs: Job[], staleTime: number): Job[] {
  logger.info(`filterForStaleJobs`, { staleTime, jobs });
  const result = jobs.filter(
    (job: Job) => Date.now() - job.updatedAt > staleTime,
  );
  logger.info(`filterForStaleJobs result`, { result });
  return result;
}

async function processJobs(jobs: Job[], limit: number = 50): Promise<void> {
  logger.info(`processJobs`, { jobs, limit });
  const jobsToProcess = jobs.slice(0, Math.min(jobs.length, limit));
  await Promise.all(jobsToProcess.map(processJob));
  logger.info(`processJobs completed`, { jobsToProcess });
}

async function processJob(job: Job): Promise<void> {
  logger.info(`processJob`, { job });
  try {
    await saveJobWithStatus(job, "in-progress");

    job.result = await processFile(job.file);
    await saveJobWithStatus(job, "completed");

    await kv.set(`group:${job.groupId}:${job.id}`, "completed");
    if (await checkGroupCompletion(job.groupId)) {
      await finalizeGroup(job.groupId);
    }
  } catch (error: any) {
    logger.error(`processJob error`, { error: error.message, job });
    await handleJobFailure(job);
  }
}

async function saveJobWithStatus(
  job: Job,
  status: Job["status"],
): Promise<void> {
  logger.info(`saveJobWithStatus`, { job, status });
  job.status = status;
  job.updatedAt = Date.now();
  await kv.set(`job:${job.id}`, JSON.stringify(job));
}

async function handleJobFailure(job: Job): Promise<void> {
  logger.info(`handleJobFailure`, { job });
  await saveJobWithStatus(job, "failed");
  await kv.set(`group:${job.groupId}:${job.id}`, "failed");
}

async function assembleDocument(jobs: Job[]): Promise<Record<string, unknown>> {
  logger.info(`assembleDocument`, { jobs });
  if (jobs.length === 0) {
    logger.warn("No jobs to assemble");
    return {};
  }
  const entries = jobs.map((job) => {
    return [job.file.path, job.result];
  });
  const metadata = (await fetchRepoMetadata(jobs[0].owner, jobs[0].repo)) ?? {};
  entries.push(["metadata", `${metadata}`]);
  const result = Object.fromEntries(entries);
  logger.info(`assembleDocument result`, { result });
  return result;
}

async function checkGroupCompletion(groupId: string): Promise<boolean> {
  logger.info(`checkGroupCompletion`, { groupId });
  const jobs = await getJobs(`group:${groupId}:*`);
  const result = jobs.every(({ status }) => status === "completed");
  logger.info(`checkGroupCompletion result`, { result });
  return result;
}

async function finalizeGroup(groupId: string): Promise<void> {
  logger.info(`finalizeGroup`, { groupId });
  const jobs = await getJobs(`group:${groupId}:*`);
  const { owner, repo } = jobs[0];
  const filename = getASTFilename(owner, repo);
  const finalDocument = await assembleDocument(jobs);
  saveASTsToFile(filename, finalDocument);
  logger.info(`ASTs for ${repo} have been saved to ${filename}.`);
  await uploadDocument(filename);
  await kv.set(`group:${groupId}:status`, "completed");
}

async function processFile(file: FileInfo): Promise<string> {
  logger.info(`processFile`, { file });
  const astData = fileInfoToAstData(file);
  const result = JSON.stringify(astData);
  logger.info(`processFile result`, { result });
  return result;
}

async function uploadDocument(filename: string): Promise<void> {
  logger.info(`uploadDocument`, { filename });
  const uploadable = fs.createReadStream(filename);
  const uploaded = await openai.beta.vectorStores.files.uploadAndPoll(
    // @ts-expect-error - let it throw
    astVectorStoreId,
    uploadable,
  );
  logger.info(`Uploaded ${filename} to OpenAI vector store`, { uploaded });
}

function getASTFilename(owner: string, repo: string): string {
  const result = `${owner.replaceAll(/_/g, "ZzDasHzZ")}_${repo.replaceAll(
    /_/g,
    "ZzDasHzZ",
  )}-asts.json`;
  logger.info(`getASTFilename`, { result });
  return result;
}

function saveASTsToFile(filename: string, data: object): void {
  logger.info(`saveASTsToFile`, { filename, data });
  fs.writeFileSync(filename, stringifySafe(data), "utf8");
}

async function summarizeFileOpenAI(filename: string, fileContent: string) {
  logger.info("summarizeFileOpenAI", { filename, fileContent });
  const currentTime = Date.now();
  if (currentTime - lastApiCallTime < RATE_LIMIT_WINDOW_MS) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        RATE_LIMIT_WINDOW_MS - (currentTime - lastApiCallTime),
      ),
    );
  }
  lastApiCallTime = Date.now();
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a helpful repo assistant. Be concise but insightful.",
        },
        {
          role: "user",
          content: `Summarize the code for this file (${filename}) and its purpose. What functions and UI elements are written here? : ${fileContent}. Assume explanation for the common web developer.`,
        },
      ],
      model: "gpt-4o",
      max_tokens: 175,
    });
    const summary = completion.choices[0].message.content;
    logger.info("summarizeFileOpenAI result", { summary });
    return summary;
  } catch (error: any) {
    logger.error(`Error summarizing file ${filename} using OpenAI`, {
      error: error.message,
    });
    throw error;
  }
}

async function generateAST(file: string, content: string): Promise<unknown> {
  logger.info(`generateAST`, { file });
  let result;
  try {
    const fileType = getFileType(file);
    switch (fileType) {
      case "JavaScript/TypeScript":
        result = await babel.parseAsync(content, {
          ...babelConfig,
          filename: file,
        });
        break;
      case "JSON":
        result = parseJSON(content);
        break;
      case "HTML":
        result = htmlparser2.parseDocument(content);
        break;
      case "CSS":
        result = postcss.parse(content);
        break;
      case "Markdown":
        const htmlFromMarkdown = await marked(content);
        result = htmlparser2.parseDocument(htmlFromMarkdown);
        break;
      default:
        logger.info(`Skipping unsupported file type: ${file}`);
        result = {};
    }
  } catch (error: any) {
    logger.error(`Error processing ${file}`, {
      error: error.message,
    });
    result = {};
  }
  logger.info(`generateAST result`, { result });
  return result;
}

function parseJSON(file: string, code: string = "{}"): Record<string, unknown> {
  logger.info(`parseJSON`, { file, code });
  try {
    const parsed = JSON.parse(code);
    const ast = deriveSchema(parsed);
    const result = { type: "object", properties: ast };
    logger.info(`parseJSON result`, { result });
    return result;
  } catch (error: any) {
    logger.error(`Error parsing JSON in file ${file}`, {
      message: error.message,
    });
    throw error;
  }
}

function deriveSchema(jsonObject: Record<string, unknown>) {
  logger.info(`deriveSchema`, { jsonObject });
  const getType = (value: unknown) => {
    if (Array.isArray(value)) {
      return "array";
    } else if (value === null) {
      return "null";
    } else {
      return typeof value;
    }
  };

  const schema: any = {};
  for (const key in jsonObject) {
    const value: any = jsonObject[key];
    schema[key] = { type: getType(value) };
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      schema[key].properties = deriveSchema(value);
    }
  }
  logger.info(`deriveSchema result`, { schema });
  return schema;
}

async function fetchRepoMetadata(
  owner: string,
  repo: string,
): Promise<Metadata | null> {
  logger.info(`fetchRepoMetadata`, { owner, repo });
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${GH_PAT}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const data = await response.json();
    const result = {
      name: data.name,
      description: data.description,
      demoLink: data.homepage || "No demo link provided",
    };
    logger.info(`fetchRepoMetadata result`, { result });
    return result;
  } catch (error: any) {
    logger.error("Error fetching repository metadata:", {
      error: error.message,
    });
    return null;
  }
}

function stringifySafe(obj: unknown) {
  logger.info(`stringifySafe`, { obj });
  const seen = new WeakSet();
  const result = JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  });
  logger.info(`stringifySafe result`, { result });
  return result;
}

async function fileInfoToAstData(file: FileInfo): Promise<AstData> {
  logger.info(`fileInfoToAstData`, { file });
  const fileContent = await fetchFile(file.download_url);
  const ast = await generateAST(file.path, fileContent);
  const summary = (await summarizeFileOpenAI(file.path, fileContent)) ?? "";
  const astData = {
    file: file.path,
    type: getFileType(file.path),
    ast: ast as AST,
    summary: summary,
    sourceCode: JSON.stringify(fileContent),
  };
  logger.info(`fileInfoToAstData result`, { astData });
  return astData;
}
