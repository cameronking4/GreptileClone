import logger from "./logger";
import * as fs from "fs-extra";
import * as path from "path";
import type { FileInfo } from "./types";
import dotenv from "dotenv";
dotenv.config();

const GH_PAT = process.env.GITHUB_TOKEN;
logger.info("lib env variables", process.env);
export async function downloadFile(
  url: string,
  filePath: string,
): Promise<void> {
  logger.info("downloadFile", { url, filePath });
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `token ${GH_PAT}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      await fs.writeFile(filePath, Buffer.from(arrayBuffer));
      logger.info("Downloaded file", { url, filePath });
      return;
    } catch (error: any) {
      logger.error("Error downloading file, retrying...", {
        attempt,
        error: error.message,
      });
      if (attempt === 5)
        throw new Error(`Failed to download file after 5 attempts: ${url}`);
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt)),
      ); // Exponential backoff
    }
  }
}

export async function fetchFile(url: string): Promise<string> {
  logger.info("fetchFile", { url });
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `token ${GH_PAT}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }
      const data = await response.text();
      logger.info("Fetched file", { url, data });
      return data;
    } catch (error: any) {
      logger.warn("Error fetching file, retrying...", {
        attempt,
        error: error.message,
      });
      if (attempt === 5)
        throw new Error(`Failed to fetch file after 5 attempts: ${url}`);
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt)),
      ); // Exponential backoff
    }
  }
  return ""; // for the compiler, not possible....?
}

export async function fetchFiles(
  owner: string,
  repo: string,
  path = "",
): Promise<FileInfo[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  logger.info("fetchFiles", { url, owner, repo, path });
  try {
    const headers = {
      Authorization: `token ${GH_PAT}`,
      Accept: "application/vnd.github.v3+json",
    };
    logger.info("fetchFiles", { headers });
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch files: ${response.statusText}`);
    }
    const data = await response.json();
    logger.info("fetchFiles", { data });
    let files: FileInfo[] = [];
    for (const item of data) {
      if (item.type === "file") {
        files.push({
          path: item.path,
          download_url: item.download_url,
        });
      } else if (item.type === "dir") {
        const moreFiles: FileInfo[] = await fetchFiles(owner, repo, item.path);
        files = files.concat(moreFiles);
      }
    }
    logger.info("Fetched files", { files });
    return files;
  } catch (error: any) {
    logger.error("Error fetching repository files:", {
      error: error.message,
    });
    throw error; // Rethrow to be caught by the calling function
  }
}

export async function checkoutProject(
  repoPath: string,
  localDir: string,
): Promise<void> {
  logger.info("checkoutProject", { repoPath, localDir });

  const repoParts = repoPath.replace("https://github.com/", "").split("/");
  const owner = repoParts[0];
  const repo = repoParts[1];
  const ref = repoParts[3] || "main";
  const dirPath = repoParts.slice(4).join("/");

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${ref}`;

  logger.info("checkoutProject apiUrl", { apiUrl });

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `token ${GH_PAT}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch directory contents: ${response.statusText}`,
      );
    }
    const contents = await response.json();

    if (!Array.isArray(contents)) {
      throw new Error("Failed to fetch directory contents.");
    }

    await fs.ensureDir(localDir);

    for (const item of contents) {
      if (item.type === "file") {
        const filePath = path.join(localDir, item.name);
        logger.info("Downloading file", {
          download_url: item.download_url,
          filePath,
        });
        await downloadFile(item.download_url, filePath);
      } else if (item.type === "dir") {
        const newLocalDir = path.join(localDir, item.name);
        await checkoutProject(
          `https://github.com/${owner}/${repo}/tree/${ref}/${dirPath}/${item.name}`,
          newLocalDir,
        );
      }
    }

    logger.info("Directory contents checked out successfully.", { localDir });
  } catch (error: any) {
    logger.error("Error checking out directory:", { error: error.message });
    throw new Error("Error checking out directory.");
  }
}

export function getFileType(file: string) {
  logger.info("getFileType", { file });
  const ext = path.extname(file).toLowerCase();
  let type;
  switch (ext) {
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx":
      type = "JavaScript/TypeScript";
      break;
    case ".json":
      type = "JSON";
      break;
    case ".html":
      type = "HTML";
      break;
    case ".css":
      type = "CSS";
      break;
    case ".md":
      type = "Markdown";
      break;
    // Add common video file extensions here
    case ".mp4":
    case ".avi":
    case ".mov":
    case ".wmv":
    case ".gif":
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".tiff":
    case ".svg":
    case ".bmp":
    case ".webp":
    case ".ico":
    case ".webm":
    case ".mov":
    case ".ttf":
    case ".otf":
    case ".woff":
    case ".woff2":
      type = "Media";
      break;
    default:
      type = "Unknown";
  }
  logger.info("getFileType result", { file, type });
  return type;
}
