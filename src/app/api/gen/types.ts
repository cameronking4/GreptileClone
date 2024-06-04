export interface FileContent {
  content: string | object;
}

export interface DirectoryContent {
  [key: string]: FileContent;
}

export type ChatStatus = "seen" | "delivered" | "sent";

export type Type = "image" | "text" | "file" | "mixed";

export type MimeType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/gif";

export type MessageBase = {
  id: string;
  type: Type;
  author: {
    id: string;
    firstName: string;
    lastName: string;
    imageUrl?: string;
  };
  createdAt: Date | number;
  status: ChatStatus;
};

export type MessageImage = MessageBase & {
  type: "image";
  name: string;
  size: number;
  uri: string;
  width: number;
  height: number;
};

export type MessageText = MessageBase & {
  type: "text";
  text: string;
};

export type MessageMixed = Omit<MessageImage, "type"> &
  Omit<MessageText, "type"> & {
    type: "mixed";
  };

export type MessageFile = MessageBase & {
  type: "file";
  mimeType: MimeType;
  uri: string;
  name: string;
  size: number;
};

// export type ThreadListItem = {
//   threadId: string;
//   name: string;
// };

export type ChatMessage =
  | MessageText
  | MessageImage
  | MessageFile
  | MessageMixed;

export type Step = {
  file_path: string;
  modification: string;
};

export type Plan = Array<Step>;
