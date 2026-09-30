package com.animalcup.pad;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {

    private LinearLayout connectCard;
    private FrameLayout webContainer;
    private EditText hostInput;
    private EditText roomInput;
    private TextView statusText;
    private WebView webView;
    private SharedPreferences prefs;

    // Bump this in lockstep with android-pad/version.json whenever you rebuild the
    // APK, so the web UI can tell an installed device it's running an old build.
    private static final String APP_VERSION = "1.0.0";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences("pad", MODE_PRIVATE);
        connectCard = findViewById(R.id.connectCard);
        webContainer = findViewById(R.id.webContainer);
        hostInput = findViewById(R.id.hostInput);
        roomInput = findViewById(R.id.roomInput);
        statusText = findViewById(R.id.statusText);
        Button connectBtn = findViewById(R.id.connectBtn);

        hostInput.setText(prefs.getString("host", ""));
        roomInput.setText(prefs.getString("room", ""));

        connectBtn.setOnClickListener(v -> doConnect());
    }

    private void doConnect() {
        String host = hostInput.getText().toString().trim();
        String room = roomInput.getText().toString().trim().toUpperCase();

        if (host.isEmpty()) {
            statusText.setText("请填写电脑主机地址（局域网 IP）");
            return;
        }

        String url;
        if (host.startsWith("http://") || host.startsWith("https://")) {
            url = host;
            if (!room.isEmpty() && !url.contains("room=")) {
                url += (url.contains("?") ? "&" : "?") + "room=" + room;
            }
        } else {
            if (room.isEmpty()) {
                statusText.setText("请填写房间号，或从电脑二维码复制完整地址（含 http://）");
                return;
            }
            url = "http://" + host + ":13000/pad?room=" + room;
        }

        // Tell the web UI which APK build this is, so it can flag updates.
        url += (url.contains("?") ? "&" : "?") + "apk=" + APP_VERSION;

        prefs.edit().putString("host", host).putString("room", room).apply();
        loadPad(url);
    }

    private void loadPad(String url) {
        statusText.setText("正在连接 " + url + " …");
        if (webView == null) {
            webView = new WebView(this);
            webView.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            WebSettings ws = webView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setDatabaseEnabled(true);
            ws.setMediaPlaybackRequiresUserGesture(false);
            ws.setLoadWithOverviewMode(true);
            ws.setUseWideViewPort(true);
            ws.setCacheMode(WebSettings.LOAD_DEFAULT);
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            webView.setBackgroundColor(Color.BLACK);
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String u) {
                    connectCard.setVisibility(View.GONE);
                    webContainer.setVisibility(View.VISIBLE);
                    statusText.setText("");
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                    if (req.isForMainFrame()) {
                        statusText.setText("连接失败：请确认电脑已启动、IP 正确且与手机在同一 Wi-Fi。");
                        connectCard.setVisibility(View.VISIBLE);
                        webContainer.setVisibility(View.GONE);
                    }
                }
            });
            webContainer.addView(webView);
        }
        webView.loadUrl(url);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null
                && webContainer.getVisibility() == View.VISIBLE) {
            // 在手柄页按返回 -> 回到连接卡片（不退出 App）
            webContainer.removeAllViews();
            webContainer.setVisibility(View.GONE);
            connectCard.setVisibility(View.VISIBLE);
            statusText.setText("");
            webView = null;
            return true;
        }
        return super.onKeyDown(keyCode, e);
    }
}
