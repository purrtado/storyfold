export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
};
