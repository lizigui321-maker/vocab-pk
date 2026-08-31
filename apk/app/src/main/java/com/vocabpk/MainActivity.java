package com.vocabpk;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 胖虎单词PK 安卓壳：用 WebView 加载已部署的服务器网页。
 * 所有游戏逻辑、账号、生词本都在服务器端，App 只是入口。
 * 服务器地址在 res/values/strings.xml 的 server_url 中配置。
 */
public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getString(R.string.server_url);
        if (url == null || url.contains("YOUR_DEPLOYED_URL")) {
            Toast.makeText(this,
                    "请先在 app/src/main/res/values/strings.xml 把 server_url 改成你的部署地址",
                    Toast.LENGTH_LONG).show();
        }

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);       // 网页需要 JS
        settings.setDomStorageEnabled(true);        // 支持 localStorage（token / 设置）
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false); // 允许自动播放读音

        // 所有链接留在 App 内打开（不跳浏览器）
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        webView.loadUrl(url);
    }

    // 返回键：先退回网页历史，再退出 App
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
