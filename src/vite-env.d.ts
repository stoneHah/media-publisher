/// <reference types="vite/client" />

type OpenCliResponse = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  data?: unknown;
};

type StatusResponse = {
  ok: boolean;
  cdpPort: number;
  cdpEndpoint: string | null;
  opencliHome: string;
  opencliEntry?: string;
  electronNode: string;
  target?: {
    id?: string;
    type?: string;
    title: string;
    url: string;
  };
  error?: string;
};

interface Window {
  publisher: {
    openUrl(url: string): Promise<OpenCliResponse>;
    status(): Promise<StatusResponse>;
  };
}
