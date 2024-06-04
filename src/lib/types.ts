export type FileInfo = { path: string; download_url: string };

export type Job = {
  id: string;
  file: FileInfo;
  groupId: string;
  owner: string;
  repo: string;
  status: "queued" | "in-progress" | "completed" | "failed";
  result?: string;
  createdAt: number;
  updatedAt: number;
};

export type AST = {
  file: string;
  type: string;
  ast: object;
  summary: string;
  sourceCode: string;
};

export type AstData = {
  file: string;
  type: string;
  ast: Record<string, unknown>;
  summary: string;
  sourceCode: string;
};

export type Metadata = {
  name: string;
  description: string;
  demoLink: string;
};
