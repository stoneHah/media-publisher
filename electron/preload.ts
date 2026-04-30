import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("publisher", {
  openUrl: (url: string) => ipcRenderer.invoke("opencli:open-url", url),
  status: () => ipcRenderer.invoke("opencli:status")
});
