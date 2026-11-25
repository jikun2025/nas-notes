package com.nasnotes.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.SharedPreferences;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 轻签 NasNotes 安卓壳（零第三方依赖，仅平台内置 API）。
 *
 * 架构：
 *  - 前端（仓库根目录 static/，与 PWA 完全同一份代码）打进 APK assets，
 *    挂在虚拟安全域 https://appassets.androidplatform.net/ 下由本类直接响应，
 *    因此 crypto.subtle / IndexedDB / localStorage 全部可用（安全上下文），
 *    应用离线即开，不依赖网络。
 *  - 前端所有 fetch('/api/...') 由 assets 内联注入的 _bridge.js 劫持，
 *    经 NasNative.apiAsync 用原生 HttpURLConnection 转发到用户配置的 NAS 地址
 *    （默认 http://192.168.5.10:28080），绕开 WebView 的混合内容限制。
 *  - 传输层只有密文：端到端加密在前端 WebCrypto 完成，原生层只见 ciphertext。
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String ASSET_ORIGIN = "https://" + ASSET_HOST;
    private static final String PREFS = "nn";
    private static final String PREF_SERVER = "server";
    private static final String DEFAULT_SERVER = "http://192.168.5.10:28080";
    private static final int REQ_FILE = 1001;
    private static final int REQ_MIC = 1002;

    private WebView webView;
    private SharedPreferences prefs;
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String bridgeJs;
    private String indexHtml;
    private ValueCallback<Uri[]> filePathCallback;
    private final AtomicInteger toastSeq = new AtomicInteger();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        bridgeJs = readAsset("_bridge.js");
        indexHtml = readAsset("index.html");

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 令牌/设备标识/同步设置存 localStorage
        s.setDatabaseEnabled(true);            // IndexedDB 存密文与 outbox
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new NasNative(), "NasNative");
        webView.setWebViewClient(new BridgeClient());
        webView.setWebChromeClient(new ChromeClient());

        webView.loadUrl(ASSET_ORIGIN + "/");
    }

    // ---------- 资源装载 ----------

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return "";
        }
    }

    /** 首页 HTML：在 app.js 之前内联注入桥接脚本，其余路径走 SPA 回退（与 server.py 行为一致）。 */
    private WebResourceResponse assetResponse(String path) {
        String assetName = path.equals("/") || path.equals("/index.html") ? "index.html"
                : path.replaceFirst("^/+", "");
        byte[] data;
        String mime;
        if (assetName.equals("index.html")) {
            String html = indexHtml.replace("<script src=\"/app.js\"></script>",
                    "<script>" + bridgeJs + "</script>\n  <script src=\"/app.js\"></script>");
            data = html.getBytes(StandardCharsets.UTF_8);
            mime = "text/html; charset=utf-8";
        } else {
            data = readAssetBytes(assetName);
            if (data == null) {
                // SPA 回退：未知路径返回首页（前端路由与 PWA 习惯）
                data = (indexHtml.replace("<script src=\"/app.js\"></script>",
                        "<script>" + bridgeJs + "</script>\n  <script src=\"/app.js\"></script>"))
                        .getBytes(StandardCharsets.UTF_8);
                mime = "text/html; charset=utf-8";
            } else {
                mime = mimeOf(assetName);
            }
        }
        WebResourceResponse resp = new WebResourceResponse(mimeSplit(mime), mimeSub(mime), new ByteArrayInputStream(data));
        Map<String, String> heads = new HashMap<>();
        heads.put("Cache-Control", "no-cache");
        heads.put("Service-Worker-Allowed", "/");
        heads.put("Access-Control-Allow-Origin", "*");
        resp.setResponseHeaders(heads);
        return resp;
    }

    private byte[] readAssetBytes(String name) {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json") || n.endsWith(".webmanifest")) return "application/json; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private static String mimeSplit(String mime) {
        int i = mime.indexOf('/');
        int j = mime.indexOf(';');
        return mime.substring(0, i);
    }

    private static String mimeSub(String mime) {
        int i = mime.indexOf('/');
        int j = mime.indexOf(';');
        return j > 0 ? mime.substring(i + 1, j) : mime.substring(i + 1);
    }

    // ---------- WebView 客户端 ----------

    private final class BridgeClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String host = uri.getHost();
            if (host == null) return null;
            if (host.equals(ASSET_HOST)) {
                String path = uri.getPath();
                if (path == null || path.isEmpty()) path = "/";
                // 防穿越（assets 内本来就只打包了 static 内容，双保险）
                if (path.contains("..")) return assetResponse403();
                return assetResponse(path);
            }
            // 其余外部域名：壳应用只允许访问用户配置的 NAS origin
            String server = prefs.getString(PREF_SERVER, DEFAULT_SERVER);
            try {
                String allowHost = new URL(server).getHost();
                if (allowHost != null && allowHost.equals(host)) return null; // 放行（例如手动打开 NAS 直链）
            } catch (Exception ignored) { }
            WebResourceResponse deny = new WebResourceResponse(
                    "text/plain", "utf-8", new ByteArrayInputStream("blocked by nas-notes shell".getBytes(StandardCharsets.UTF_8)));
            deny.setStatusCodeAndReasonPhrase(403, "Forbidden");
            return deny;
        }

        private WebResourceResponse assetResponse403() {
            WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream("forbidden".getBytes(StandardCharsets.UTF_8)));
            r.setStatusCodeAndReasonPhrase(403, "Forbidden");
            return r;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) { }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) { }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) filePathCallback.onReceiveValue(null);
            filePathCallback = callback;
            try {
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String accept = params != null && params.getAcceptTypes() != null && params.getAcceptTypes().length > 0
                        ? params.getAcceptTypes()[0] : "*/*";
                intent.setType(accept == null || accept.isEmpty() ? "*/*" : accept);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
            } catch (Exception e) {
                filePathCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            List<String> wanted = new ArrayList<>();
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wanted.add(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
                else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wanted.add(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            }
            if (wanted.isEmpty()) { request.deny(); return; }
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
                    && wanted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                pendingPermission = request;
                return;
            }
            request.grant(wanted.toArray(new String[0]));
        }
    }

    private PermissionRequest pendingPermission;

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MIC && pendingPermission != null) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (ok) pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingPermission.deny();
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && filePathCallback != null) {
            ValueCallback<Uri[]> cb = filePathCallback;
            filePathCallback = null;
            if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return; }
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    Uri u = data.getClipData().getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            cb.onReceiveValue(uris.toArray(new Uri[0]));
        }
    }

    // ---------- 原生桥 ----------

    private final class NasNative {

        @JavascriptInterface
        public String getServer() {
            return prefs.getString(PREF_SERVER, DEFAULT_SERVER);
        }

        @JavascriptInterface
        public void setServer(String server) {
            if (server != null && server.matches("^https?://[^/\\s]+$")) {
                prefs.edit().putString(PREF_SERVER, server).apply();
            }
        }

        /**
         * 异步 HTTP 转发：结果通过 window[cbName](status, headersJson, bodyText) 回传。
         * headersJson：请求头 JSON；path 含查询串。仅转发白名单头，body 上限 14MB（与 server.py 对齐）。
         */
        @JavascriptInterface
        public void apiAsync(final String cbName, final String method, final String path,
                             final String headersJson, final String body) {
            if (cbName == null || !cbName.matches("__nn_cb_[A-Za-z0-9_]+")) return;
            if (path == null || !path.startsWith("/api/")) return;
            io.execute(() -> {
                int status;
                Map<String, String> respHeaders = new HashMap<>();
                String text;
                try {
                    String server = prefs.getString(PREF_SERVER, DEFAULT_SERVER);
                    URL url = new URL(server + path);
                    HttpURLConnection c = (HttpURLConnection) url.openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(15000);
                    c.setRequestMethod(method == null ? "GET" : method.toUpperCase(Locale.ROOT));
                    c.setInstanceFollowRedirects(false);
                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject ho = new JSONObject(headersJson);
                        java.util.Iterator<String> it = ho.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            String kl = k.toLowerCase(Locale.ROOT);
                            if (kl.equals("x-token") || kl.equals("authorization") || kl.equals("content-type")) {
                                c.setRequestProperty(k, ho.getString(k));
                            }
                        }
                    }
                    if (body != null && !body.isEmpty()) {
                        if (body.length() > 14 * 1024 * 1024) {
                            status = 413; text = "{\"error\":\"body too large\"}";
                            respondJs(cbName, status, respHeaders, text);
                            return;
                        }
                        c.setDoOutput(true);
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    Map<String, List<String>> h = c.getHeaderFields();
                    if (h != null) {
                        for (Map.Entry<String, List<String>> e : h.entrySet()) {
                            String k = e.getKey();
                            if (k == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                            String kl = k.toLowerCase(Locale.ROOT);
                            if (kl.equals("content-type") || kl.equals("www-authenticate")) {
                                respHeaders.put(k, e.getValue().get(0));
                            }
                        }
                    }
                    if (in == null) text = "";
                    else text = slurp(in);
                    c.disconnect();
                } catch (Exception e) {
                    status = 0; // 0 = 网络层失败（对应 JS 里 TypeError: Failed to fetch 语义）
                    text = "{\"error\":\"" + safe(e.getClass().getSimpleName()) + "\"}";
                }
                respondJs(cbName, status, respHeaders, text);
            });
        }

        /** 把备份 JSON 文本保存到系统下载目录（WebView 内 blob 下载不可用的替代）。 */
        @JavascriptInterface
        public void saveText(final String filename, final String content) {
            if (filename == null || !filename.matches("[A-Za-z0-9._-]+") || !filename.endsWith(".json")) return;
            io.execute(() -> {
                try {
                    File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(
                            android.os.Environment.DIRECTORY_DOWNLOADS), "NasNotes");
                    if (!dir.exists() && !dir.mkdirs()) dir = android.os.Environment.getExternalStoragePublicDirectory(
                            android.os.Environment.DIRECTORY_DOWNLOADS);
                    File f = new File(dir, filename);
                    int i = 1;
                    while (f.exists()) { f = new File(dir, filename.replace(".json", "-" + (i++) + ".json")); }
                    try (FileOutputStream fos = new FileOutputStream(f)) {
                        fos.write(content.getBytes(StandardCharsets.UTF_8));
                    }
                    final String path = f.getAbsolutePath();
                    ui.post(() -> Toast.makeText(MainActivity.this, "备份已保存：" + path, Toast.LENGTH_LONG).show());
                    try {
                        android.media.MediaScannerConnection.scanFile(MainActivity.this,
                                new String[]{f.getAbsolutePath()}, new String[]{"application/json"}, null);
                    } catch (Exception ignored) { }
                } catch (Exception e) {
                    ui.post(() -> Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
                }
            });
        }

        private void respondJs(String cbName, int status, Map<String, String> headers, String text) {
            final String js = "window." + cbName + " && window." + cbName + "("
                    + status + ","
                    + JSONObject.quote(new JSONObject(headers).toString()) + ","
                    + JSONObject.quote(text) + ")";
            ui.post(() -> webView.evaluateJavascript(js, null));
        }
    }

    private static String slurp(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() > 16 * 1024 * 1024) break;
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static String safe(String s) {
        return s == null ? "" : s.replaceAll("[^A-Za-z0-9_.]", "");
    }

    // ---------- 生命周期 ----------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
