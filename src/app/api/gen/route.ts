import { inspect } from "util";
import logger from "@/lib/logger";
import OpenAI from "openai";
import {
  FileCitationAnnotation,
  Message,
  TextContentBlock,
} from "openai/resources/beta/threads/messages";
import { Run } from "openai/resources/beta/threads/runs/runs";
import { Thread } from "openai/resources/beta/threads/threads";
import { FileObject } from "openai/resources/files";
import { kv } from "@vercel/kv";
import * as fs from "fs-extra";
import * as path from "path";
import fg from "fast-glob";
import {
  ChatMessage,
  DirectoryContent,
  MessageImage,
  MessageMixed,
  MessageText,
  Plan,
  Step,
} from "./types";
import { v4 as uuidv4 } from "uuid";
import { checkoutProject } from "@/lib";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = "gpt-4o";

let assistantIdCode = process.env.OPENAI_CODE_ASSISTANT_ID;
let assistantIdPlanning = process.env.OPENAI_PLANNING_ASSISTANT_ID;
let assistantIdIntention = process.env.OPENAI_INTENTION_ASSISTANT_ID;
let assistantIdProjectSelection =
  process.env.OPENAI_PROJECT_SELECTION_ASSISTANT_ID;
const astVectorStoreId = process.env.OPENAI_AST_VECTOR_STORE_ID;

const identity = `
You are an expert Web Developer with more than 10 years of experience.
`.trim();

const constraintsCommon = `
Do not answer conversationally.
Only provide the information requested, directly and without commentary.
`.trim();

const constraintsNoNewFiles = `
DO NOT ADD NEW FILES. ONLY EDIT EXISTING FILES.
`.trim();

const imageDescriptionPrompt = `
${identity}
You will be provided with an image of a UI mockup of a web app.
Your description of this image will help us write requirements later.
For now, just describe what the finished web UI should look like based on this image.
${constraintsCommon}
`.trim();

const assistantInstructionsIntention = `
${identity}
Given a description of a ui mockup and/or accompanying text,
you will identify the intention and based on the intention write some clear and
simple web app requirements in a hierarchical bulleted list.
${constraintsCommon}
`.trim();

const assistantInstructionsProjectSelection = `
${identity}
Given an intention for a project,
you will search the files in your vector store for the most appropriate project
to use as a base for the user's desired outcome.
Always return a file from your vector store.
`.trim();

const assistantInstructionsPlanning = `
${identity}
The user will provided you with a source code project and their desired outcome.
Respond in json only with a plan for each EXISTING file that needs to CHANGE in format below.
${constraintsNoNewFiles}
${constraintsCommon}
Example for concept and format, only:
[
  {
    file_path: "index.js",
    modification: "give the jsx a clean, bold, modern style",
  },
  {
    file_path: "index.html",
    modification: "set the page title and opengraph data to refer to 'Sketch2App', be sure to include an element with id=\"root\" as the React root.",
  },
]
`.trim();

const assistantInstructionsCode = `
${identity}
The user will provided you with a source code file and a desired change.
Respond in code only with the complete updated file.
${constraintsCommon}
`.trim();

const composePromptIntention = (
  imageDescription: string,
  textDescription: string,
) =>
  `
Image Description:
${imageDescription}

Accompanying Message:
${textDescription}
`.trim();

const composePromptProjectSelection = (intention: string) =>
  `
Given the intention below, select the file from the vector store
that most closely represents the appropriate project to work on:
${intention}
`.trim();

const composePromptIntentionWithPaths = (
  file_paths: string[],
  intention: string,
) =>
  `
${intention}

The files available to change are listed below:
${inspect(file_paths)}
`.trim();

const composePromptCodeModification = (
  file_path: string,
  file_content: string,
  modification: string,
) =>
  `
Below are instructions for how to update a file named "${file_path}".
Perform the modifications below, responding with only the single, complete, modified file.

Be complete for this single file. Omit no code within this single file.

${constraintsNoNewFiles}
${constraintsCommon}

Instructions:
${modification}

Original Code:
${file_content}
`.trim();

// TODO:
//     - [x] post code to codesandbox (Cameron's code may do this already)
//     - [x] organize code files and directories
//     - [x] template population
//     - [x] template preparation
//     - [x] template selection
//     - [x] text to intention
//     - [x] image to intention
//     - [ ] 3rd party auth
//     - [ ] access control
//     - [ ] sanitize/parse/validate
export async function POST(request: Request) {
  try {
    const message = await request.json();
    isMessage(message);

    const hash = uuidv4();
    const dir = `./ai_code_${hash}/`;

    const requestThreadId = await createRequestThread();

    const intention = await generateIntention(message, dir, requestThreadId);
    const plan = await promptPlanningAssistant(intention, requestThreadId);
    await executePlanOnProject(dir, plan, requestThreadId);

    const paths = (await listAllFiles(dir)).filter(
      (filePath) => !/\.(ico)$/.test(filePath), // omit problematic uploads
    );
    const files = await readFilesContent(dir, paths);
    const code = { files };
    const sbxResp = await createCodesandbox(code);
    logger.info("POST", { sbxResp });
    const sbx = {
      url: `https://codesandbox.io/embed/${sbxResp.sandbox_id}?fontsize=11&view=preview&hidenavigation=1&theme=dark`,
      preview: `https://${sbxResp.sandbox_id}.csb.app/`,
    };

    logger.info("POST", { sbx });
    return new Response(JSON.stringify(sbx));
  } catch (error: any) {
    logger.error(error.message, { error: error.message });
    return new Response(error, { status: 500 });
  }
}

async function createCodesandbox(body: Record<string, unknown>) {
  logger.info("createCodesandbox", { body });
  return fetch("https://codesandbox.io/api/v1/sandboxes/define?json=1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  }).then((x) => x.json());
  // .then((data) => generateIframeData(data.sandbox_id));
}

async function describeImage(url: string, thread_id: string): Promise<string> {
  const {
    choices: [
      {
        message: { content },
      },
    ],
  } = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: imageDescriptionPrompt,
          },
          {
            type: "image_url",
            image_url: { url },
          },
        ],
      },
    ],
  });

  return content ?? "Unable to process image";
}

async function createRequestThread(): Promise<string> {
  logger.info("createRequestThread - ENTRY");
  const { id }: Thread = await openai.beta.threads.create();
  logger.info("createRequestThread - EXIT", { id });
  return id;
}

async function handleActionableRunStatus(
  run: Run,
  thread_id: string,
  dir: string,
): Promise<Message[]> {
  // Check if the run is completed
  if (run.status === "completed") {
    let messages = await openai.beta.threads.messages.list(thread_id);
    logger.info("handleActionableRunStatus", { messages });
    return messages.data;
  } else if (run.status === "requires_action") {
    logger.info("handleActionableRunStatus", { run });
    return await handleRequiresAction(run, thread_id, dir);
  } else {
    logger.error("Run did not complete:", { run });
  }
  return [];
}

async function listFiles(): Promise<FileObject[]> {
  logger.info("listFiles - ENTRY");
  const { data: list } = await openai.files.list();
  logger.info("listFiles - EXIT", { list });
  return list;
}

async function getFile(file_id: string): Promise<FileObject | null> {
  logger.info("getFile - ENTRY");
  try {
    const result = await openai.files.retrieve(file_id);
    logger.info("getFile - EXIT", { result });
    return result;
  } catch (error: any) {
    logger.error("getFile - ERROR", { error: error.message });
    return null;
  }
}

async function sleepSecs(secs: number) {
  return new Promise((resolve) => setTimeout(resolve, secs * 1000));
}

async function handleRequiresAction(
  run: Run,
  thread_id: string,
  dir: string,
): Promise<Message[]> {
  if (
    run.required_action &&
    run.required_action.submit_tool_outputs &&
    run.required_action.submit_tool_outputs.tool_calls
  ) {
    // Loop through each tool in the required action section
    const toolOutputs = (
      await Promise.all(
        run.required_action.submit_tool_outputs.tool_calls.map(async (tool) => {
          logger.info("handleRequiresAction", { tool });
          if (tool.function.name === "foo") {
            // if (tool.function.name === "assemble_sandbox") {
            const paths = await listAllFiles(dir);
            const files = await readFilesContent(dir, paths);
            const result = {
              tool_call_id: tool.id,
              output: JSON.stringify({ files }),
            };
            logger.info("handleRequiresAction", { result });
            return result;
          }
          return {};
        }),
      )
    ).filter(Boolean);

    // Submit all tool outputs at once after collecting them in a list
    if (toolOutputs.length > 0) {
      run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
        thread_id,
        run.id,
        { tool_outputs: toolOutputs },
      );
      logger.info("Tool outputs submitted successfully.", { toolOutputs, run });
    } else {
      logger.info("No tool outputs to submit.");
    }

    // Check status after submitting tool outputs
    return handleActionableRunStatus(run, thread_id, dir);
  }
  return [];
}

function isMessage(message: any): message is ChatMessage {
  logger.info("isMessage - ENTRY", { message });
  const isImage = (msg: any): msg is MessageImage => msg.type === "image";
  const isText = (msg: any): msg is MessageText => msg.type === "text";
  const isMixed = (msg: any): msg is MessageMixed => msg.type === "mixed";
  const isChatMessage = (msg: any): msg is ChatMessage =>
    isImage(msg) || isText(msg) || isMixed(msg);
  if (!message) {
    throw new Error("Missing message.");
  }
  if (!isChatMessage(message)) {
    throw new Error("Invalid message.");
  }
  logger.info("isMessage - EXIT");
  return true;
}

function parseReplyJson(
  messages: OpenAI.Beta.Threads.Messages.Message[],
): Record<string, unknown> {
  logger.info("parseReplyJson", { messages });
  const result = JSON.parse(parseReplyString(messages));
  logger.info("parseReplyJson", { result });
  return result;
}

function parseReplyString(
  messages: OpenAI.Beta.Threads.Messages.Message[],
): string {
  logger.info("parseReplyString", { messages });
  const result = stripMarkdown(
    (messages[0].content[0] as TextContentBlock).text.value,
  );
  logger.info("parseReplyString", { result });
  return result;
}

async function parseReplyProjectURL(
  messages: OpenAI.Beta.Threads.Messages.Message[],
): Promise<string> {
  logger.info("parseReplyProjectURL", { messages });

  // NOTE: assuming first annotation is fine without checking
  const file_id = (
    (messages[0].content[0] as TextContentBlock).text
      .annotations?.[0] as FileCitationAnnotation
  )?.file_citation?.file_id;

  const file = await getFile(file_id);
  const result =
    "https://github.com/" +
    (file?.filename
      ?.replaceAll(/_/g, "/")
      .replace(/-asts\.json$/, "")
      .replaceAll(/ZzDasHzZ/g, "_") ??
      "vercel/vercel/tree/main/examples/nextjs");

  logger.info("parseReplyProjectURL", { result });
  return result;
}

const listAllFiles = async (dir: string): Promise<string[]> => {
  logger.info("listAllFiles", { dir });
  const result = await fg("**/*", { cwd: dir, onlyFiles: true, dot: true });
  logger.info("listAllFiles", { result });
  return result;
};

const readFilesContent = async (
  dir: string,
  files: string[],
): Promise<DirectoryContent> => {
  logger.info("readFilesContent", { dir, files });
  const result: DirectoryContent = {};

  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, "utf8");
    result[file] = { content };
  }

  logger.info("readFilesContent", { result });
  return result;
};

async function executePlanOnProject(
  projDir: string,
  plan: Plan,
  thread_id: string,
  // user: ChatMessage["author"],
): Promise<void> {
  logger.info("executePlanOnProject", { projDir, plan, thread_id });
  const performModification = createPerformModification(projDir, thread_id);
  for (const step of plan) {
    await performModification(step);
  }
}

function createPerformModification(
  projDir: string,
  thread_id: string,
  // author: ChatMessage["author"],
) {
  return async function performModification(step: Step): Promise<void> {
    logger.info("performModification", { step });
    const filePath = path.join(projDir, step.file_path);
    let file_content = "blank";
    try {
      file_content = await fs.readFile(filePath, "utf8");
    } catch {
      logger.warn(`File not found: ${filePath}`);
    }
    const prompt = composePromptCodeModification(
      step.file_path,
      file_content,
      step.modification,
    );
    const modifiedContent = await promptCodingAssistant(prompt, thread_id);
    const cleanedContent = stripMarkdown(modifiedContent);
    await writeFileWithMkdir(filePath, cleanedContent);
  };
}

async function writeFileWithMkdir(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content);
}

async function promptCodingAssistant(
  prompt: string,
  thread_id: string,
): Promise<string> {
  logger.info("promptCodingAssistant", { prompt });
  const assistant_id = await getCodeAssistantId();
  await addMessageToThread(thread_id, prompt);
  const run = await runThread(thread_id, assistant_id);
  const messages = await handleRunStatus(run, thread_id);
  const result = parseReplyString(messages);
  logger.info("promptCodingAssistant", { result });
  return result;
}

async function promptIntentionAssistant(
  prompt: string,
  thread_id: string,
): Promise<string> {
  logger.info("promptIntentionAssistant", { prompt });
  const assistant_id = await getIntentionAssistantId();
  await addMessageToThread(thread_id, prompt);
  const run = await runThread(thread_id, assistant_id);
  const messages = await handleRunStatus(run, thread_id);
  const result = parseReplyString(messages);
  logger.info("promptIntentionAssistant", { result });
  return result;
}

async function getCodeAssistantId(): Promise<string> {
  logger.info("getCodeAssistantId", {
    assistantIdCode,
    assistantInstructionsCode,
  });
  assistantIdCode ??= (
    await openai.beta.assistants.create({
      name: "Sketch2App Assistant - Write Code",
      instructions: assistantInstructionsCode,
      model: MODEL,
    })
  ).id;
  logger.info("getCodeAssistantId", { assistantIdCode });
  return assistantIdCode;
}

async function getIntentionAssistantId(): Promise<string> {
  logger.info("getIntentionAssistantId", {
    assistantIdIntention,
    assistantInstructionsIntention,
  });
  assistantIdIntention ??= (
    await openai.beta.assistants.create({
      name: "Sketch2App Assistant - Ascertain Intention",
      instructions: assistantInstructionsIntention,
      model: MODEL,
    })
  ).id;
  logger.info("getIntentionAssistantId", { assistantIdIntention });
  return assistantIdIntention;
}

async function getPlanningAssistantId(): Promise<string> {
  logger.info("getPlanningAssistantId", {
    assistantIdPlanning,
    assistantInstructionsPlanning,
  });
  assistantIdPlanning ??= (
    await openai.beta.assistants.create({
      name: "Sketch2App Assistant - Compose Plan",
      instructions: assistantInstructionsPlanning,
      model: MODEL,
    })
  ).id;
  logger.info("getPlanningAssistantId", { assistantIdPlanning });
  return assistantIdPlanning;
}

async function getProjectSelectionAssistantId(): Promise<string> {
  logger.info("getProjectSelectionAssistantId", {
    assistantIdProjectSelection,
    assistantInstructionsProjectSelection,
  });
  assistantIdProjectSelection ??= (
    await openai.beta.assistants.create({
      name: "Sketch2App Assistant - Project Selection",
      instructions: assistantInstructionsProjectSelection,
      model: MODEL,
      tools: [
        {
          type: "file_search",
        },
      ],
      tool_resources: {
        file_search: {
          vector_store_ids: [
            // @ts-expect-error - let it throw
            astVectorStoreId,
          ],
        },
      },
    })
  ).id;
  logger.info("getProjectSelectionAssistantId", {
    assistantIdProjectSelection,
  });
  return assistantIdProjectSelection;
}

async function handleRunStatus(
  run: Run,
  thread_id: string,
): Promise<Message[]> {
  if (run.status === "completed") {
    let messages = await openai.beta.threads.messages.list(thread_id);
    logger.info("handleRunStatus", { messages });
    return messages.data;
  }

  logger.error("handleRunStatus - Run did not complete", { run });
  return [];
}

async function addMessageToThread(
  thread_id: string,
  content: string,
): Promise<void> {
  await openai.beta.threads.messages.create(thread_id, {
    role: "user",
    content,
  });
}

async function runThread(
  thread_id: string,
  assistant_id: string,
): Promise<Run> {
  logger.info("runThread", { thread_id, assistant_id });
  const run = await openai.beta.threads.runs.createAndPoll(thread_id, {
    assistant_id,
    // tool_choice: "required",
  });
  logger.info("runThread", { run });
  return run;
}

function stripMarkdown(text: string): string {
  const markdownCodeBlockRegex = /^```(\w*)\n([\s\S]*?)^```/gm;
  let match;

  if ((match = markdownCodeBlockRegex.exec(text)) !== null) {
    return match[2].trim();
  }

  return text;
}

async function generateIntention(
  message: ChatMessage,
  dir: string,
  thread_id: string,
): Promise<string> {
  logger.info("generateIntention", { message });
  let imageDescription = "No image given.";
  let textDescription = "No additional text given.";

  switch (message.type) {
    case "image":
      imageDescription = await describeImage(message.uri, thread_id);
      break;
    case "text":
      textDescription = message.text;
      break;
    case "mixed":
      textDescription = message.text;
      imageDescription = await describeImage(message.uri, thread_id);
      break;
    default:
      throw new Error("Invalid message.");
  }

  const intention = await composeIntention(
    imageDescription,
    textDescription,
    thread_id,
  );

  // const projects = await listProjects();
  const projectSelection = await promptProjectSelectionAssistant(
    intention,
    thread_id,
  );
  await checkoutProject(projectSelection, dir);
  const paths = await listAllFiles(dir);
  if (paths.length === 0) {
    throw new Error("No files found in project.");
  }

  // const projectOverview = await readFilesContent(dir, paths);
  const result = composePromptIntentionWithPaths(paths, intention);

  logger.info("generateIntention", { result });
  return result;
}

async function promptPlanningAssistant(
  prompt: string,
  thread_id: string,
): Promise<Plan> {
  logger.info("promptPlanningAssistant", { prompt, thread_id });
  const assistant_id = await getPlanningAssistantId();
  await addMessageToThread(thread_id, prompt);
  const run = await runThread(thread_id, assistant_id);
  const messages = await handleRunStatus(run, thread_id);
  const result = parseReplyJson(messages) as unknown as Plan;
  logger.info("promptPlanningAssistant", { result });
  return result;
}

async function composeIntention(
  imageDescription: string,
  textDescription: string,
  thread_id: string,
): Promise<string> {
  logger.info("composeIntention", {
    imageDescription,
    textDescription,
    thread_id,
  });
  const prompt = composePromptIntention(imageDescription, textDescription);
  return await promptIntentionAssistant(prompt, thread_id);
}

async function listProjects(): Promise<string[]> {
  logger.info("listProjects");

  let result = await kv.get<string[]>("projects");
  result ??= ["https://github.com/vercel/vercel/tree/main/examples/nextjs"];

  logger.info("listProjects", { result });
  return result;
}

async function promptProjectSelectionAssistant(
  intention: string,
  thread_id: string,
): Promise<string> {
  logger.info("promptProjectSelectionAssistant", { intention, thread_id });
  const assistant_id = await getProjectSelectionAssistantId();
  const prompt = composePromptProjectSelection(intention);
  await addMessageToThread(thread_id, prompt);
  const run = await runThread(thread_id, assistant_id);
  const messages = await handleRunStatus(run, thread_id);
  const projectSelection = parseReplyProjectURL(messages);
  logger.info("promptProjectSelectionAssistant", { projectSelection });
  return projectSelection;
}
