package com.pinknbook.app

import android.os.Bundle
import android.os.Build
import android.graphics.Rect
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var mainWebView: WebView? = null
  private var amazonSignIn: AmazonSignIn? = null

  // Native-only entry point: deliberately absent from the JavascriptInterface.
  @androidx.annotation.Keep
  fun openAmazonSignIn(url: String, title: String, note: String) {
    require(AmazonSignIn.isAmazonPath(url, "/ap/signin"))
    runOnUiThread {
      // Superseding an attempt must not cancel its replacement's PKCE state.
      amazonSignIn?.close(false)
      amazonSignIn = AmazonSignIn(this, url, title, note) { redirect ->
        val detail = redirect?.let { org.json.JSONObject.quote(it) } ?: "null"
        mainWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('pntome-signin',{detail:$detail}))", null)
        amazonSignIn = null
      }.also { it.show() }
    }
  }

  @androidx.annotation.Keep
  fun clearAmazonCookies() {
    runOnUiThread {
      amazonSignIn?.close()
      android.webkit.CookieManager.getInstance().removeAllCookies {
        android.webkit.CookieManager.getInstance().flush()
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    mainWebView = webView
    super.onWebViewCreate(webView)
    val bridge = ReaderGestures(webView)
    webView.addJavascriptInterface(bridge, "PntomeReader")
    webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> bridge.update() }
  }

  class ReaderGestures(private val webView: WebView) {
    // Accessed only on the UI thread; JavascriptInterface calls arrive off-thread.
    private var enabled = false

    @JavascriptInterface
    fun setGestureExclusion(value: Boolean) {
      webView.post {
        enabled = value
        update()
      }
    }

    fun update() {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
      if (!enabled || webView.width == 0 || webView.height == 0) {
        webView.systemGestureExclusionRects = emptyList()
        return
      }
      val density = webView.resources.displayMetrics.density
      // Android grants at most 200 dp per edge. Centre at 65% for thumb turns,
      // leaving the upper/lower edges available for the normal Back gesture.
      val height = (200 * density).toInt().coerceAtMost(webView.height)
      val width = (24 * density).toInt().coerceAtMost(webView.width / 2)
      val top = (webView.height * .65f - height / 2).toInt()
        .coerceIn(0, webView.height - height)
      webView.systemGestureExclusionRects = listOf(
        Rect(0, top, width, top + height),
        Rect(webView.width - width, top, webView.width, top + height)
      )
    }
  }

  override fun onDestroy() {
    amazonSignIn?.close()
    mainWebView = null
    super.onDestroy()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
