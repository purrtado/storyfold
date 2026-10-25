export type MessageControls = "menu" | "inline";

const storageKey = "storyfold-message-controls";

export function storedMessageControls(): MessageControls {
  return localStorage.getItem(storageKey) === "inline" ? "inline" : "menu";
}

export function storeMessageControls(value: MessageControls) {
  localStorage.setItem(storageKey, value);
}
