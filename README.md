# Media Publisher

Electron + React POC for controlling an embedded Electron browser target through OpenCLI CDP adapters.

## Development

```bash
npm install
npm run dev
```

The app starts Electron with CDP on `127.0.0.1:9240`. OpenCLI runtime files are generated under the Electron user data directory, not the user's real `~/.opencli`.

## POC

The first OpenCLI command is:

```bash
opencli media-publisher open https://example.com -f json
```

Inside the app, the renderer invokes the same adapter through IPC and the Electron main process points OpenCLI at the embedded `WebContentsView` target.
