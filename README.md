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

The local runtime also registers a POC Douyin comment adapter against the same embedded browser:

```bash
opencli douyin comments --random --limit 20 -f json
opencli douyin comments https://www.douyin.com/video/<aweme_id> --limit 20 -f json
opencli douyin comments AI教程 --limit 20 -f json
```

The React control pane includes a hashtag keyword search. It calls `opencli douyin hashtag search --keyword <keyword> --limit 1 -f json`, then loads comments from the first matching video in the embedded browser. If the built-in hashtag command returns an empty creator API response, the POC falls back to keyword video lookup in the same embedded Douyin session.

This only verifies Electron CDP control and read-only comment extraction. It may require a logged-in Douyin session in the embedded browser, and it does not perform publishing or upload.
