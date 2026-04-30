import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("publisher", {
  openUrl: (url: string) => ipcRenderer.invoke("opencli:open-url", url),
  hashtagComments: (keyword: string) => ipcRenderer.invoke("opencli:hashtag-comments", keyword),
  status: () => ipcRenderer.invoke("opencli:status")
});
