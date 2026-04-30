import { AlertCircle, CheckCircle2, ExternalLink, Loader2, MessageCircle, RefreshCw, Search, Send } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { cn } from "./lib/utils";

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

type CommentItem = {
  index: number;
  cid: string;
  text: string;
  nickname: string;
  digg_count: number;
  reply_count: number;
  ip_label: string;
  create_time: string;
};

type HashtagCommentsData = {
  keyword: string;
  hashtag: {
    name?: string;
    id?: string;
    view_count?: number;
  };
  video: {
    aweme_id?: string;
    video_url?: string;
    title?: string;
    picked_text?: string;
    comment_count?: number;
    comments?: CommentItem[];
  } | null;
};

const DEFAULT_URL = "https://example.com";
const DEFAULT_KEYWORD = "AI教程";

function outputText(value: unknown) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export default function App() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [keyword, setKeyword] = useState(DEFAULT_KEYWORD);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [result, setResult] = useState<OpenCliResponse | null>(null);
  const [hashtagResult, setHashtagResult] = useState<OpenCliResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [hashtagLoading, setHashtagLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);

  const hashtagData = useMemo(() => {
    const data = hashtagResult?.data as HashtagCommentsData | undefined;
    return data?.hashtag && "video" in data ? data : null;
  }, [hashtagResult]);

  const normalizedOutput = useMemo(() => {
    if (!result) return "";
    const lines = [
      result.data ? outputText(result.data) : "",
      result.data ? "" : result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean);
    return lines.join("\n\n");
  }, [result]);

  async function refreshStatus() {
    setStatusLoading(true);
    try {
      setStatus(await window.publisher.status());
    } finally {
      setStatusLoading(false);
    }
  }

  async function openUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const response = await window.publisher.openUrl(url);
      setResult(response);
      await refreshStatus();
    } finally {
      setLoading(false);
    }
  }

  async function searchHashtag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHashtagLoading(true);
    setHashtagResult(null);
    setResult(null);
    try {
      const response = await window.publisher.hashtagComments(keyword);
      setHashtagResult(response);
      setResult(response);
      await refreshStatus();
    } finally {
      setHashtagLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  return (
    <main className="app-shell">
      <section className="control-pane">
        <div className="stack gap-6">
          <header className="stack gap-2">
            <div className="eyebrow">OpenCLI POC</div>
            <h1>Media Publisher</h1>
          </header>

          <form className="stack gap-3" onSubmit={openUrl}>
            <label className="field-label" htmlFor="target-url">
              URL
            </label>
            <div className="url-row">
              <input
                id="target-url"
                className="input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                spellCheck={false}
              />
              <button className="icon-button primary" type="submit" disabled={loading} aria-label="Open URL">
                {loading ? <Loader2 className="icon spin" /> : <Send className="icon" />}
              </button>
            </div>
          </form>

          <section className="panel">
            <form className="stack gap-3" onSubmit={searchHashtag}>
              <label className="field-label" htmlFor="hashtag-keyword">
                Hashtag
              </label>
              <div className="url-row">
                <input
                  id="hashtag-keyword"
                  className="input"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  spellCheck={false}
                />
                <button className="icon-button primary" type="submit" disabled={hashtagLoading} aria-label="Search hashtag">
                  {hashtagLoading ? <Loader2 className="icon spin" /> : <Search className="icon" />}
                </button>
              </div>
            </form>

            <div className="comment-result">
              <div className="panel-header compact">
                <div className="panel-title">Comments</div>
                {hashtagResult?.ok ? (
                  <div className="badge ok">exit {hashtagResult.exitCode}</div>
                ) : hashtagResult ? (
                  <div className="badge bad">exit {hashtagResult.exitCode ?? "n/a"}</div>
                ) : null}
              </div>

              {hashtagLoading ? (
                <div className="empty-state">
                  <Loader2 className="icon spin" />
                  <span>Loading</span>
                </div>
              ) : hashtagData?.video ? (
                <div className="stack gap-3">
                  <div className="topic-summary">
                    <div>
                      <span className="summary-label">Topic</span>
                      <strong>#{hashtagData.hashtag.name || hashtagData.keyword}</strong>
                    </div>
                    <div>
                      <span className="summary-label">Video</span>
                      <strong>{hashtagData.video.comment_count ?? 0} comments</strong>
                    </div>
                  </div>
                  <div className="video-title" title={hashtagData.video.video_url}>
                    {hashtagData.video.title || hashtagData.video.picked_text || hashtagData.video.aweme_id}
                  </div>
                  <div className="comments-list">
                    {(hashtagData.video.comments || []).map((comment) => (
                      <article className="comment-card" key={comment.cid || comment.index}>
                        <div className="comment-meta">
                          <span>{comment.nickname || "Unknown"}</span>
                          <span>{comment.ip_label || "-"}</span>
                          <span>{comment.digg_count} likes</span>
                        </div>
                        <p>{comment.text}</p>
                      </article>
                    ))}
                  </div>
                </div>
              ) : hashtagResult ? (
                <pre className="output compact-output">{hashtagResult.stderr || hashtagResult.stdout || "No output"}</pre>
              ) : (
                <div className="empty-state">
                  <MessageCircle className="icon" />
                  <span>No comments</span>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div className="panel-title">Runtime</div>
              <button className="icon-button ghost" type="button" onClick={refreshStatus} disabled={statusLoading} aria-label="Refresh status">
                <RefreshCw className={cn("icon", statusLoading && "spin")} />
              </button>
            </div>
            <dl className="facts">
              <div>
                <dt>CDP</dt>
                <dd>{status?.cdpPort ?? "-"}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd>{status?.electronNode ?? "-"}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd title={status?.target?.url}>{status?.target?.title || status?.target?.url || "-"}</dd>
              </div>
            </dl>
            <div className={cn("status-line", status?.ok ? "ok" : "bad")}>
              {status?.ok ? <CheckCircle2 className="icon" /> : <AlertCircle className="icon" />}
              <span>{status?.ok ? "Ready" : status?.error || "Unavailable"}</span>
            </div>
          </section>

          <section className="panel grow">
            <div className="panel-header">
              <div className="panel-title">OpenCLI</div>
              {result?.ok ? (
                <div className="badge ok">exit {result.exitCode}</div>
              ) : result ? (
                <div className="badge bad">exit {result.exitCode ?? "n/a"}</div>
              ) : null}
            </div>
            <pre className="output">{normalizedOutput || "No output"}</pre>
          </section>
        </div>
      </section>

      <section className="browser-pane" aria-hidden="true">
        <div className="browser-placeholder">
          <ExternalLink className="placeholder-icon" />
        </div>
      </section>
    </main>
  );
}
