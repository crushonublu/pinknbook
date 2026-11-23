package com.pinknbook.app

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Isolated Amazon browser. No app JavaScript bridge is installed here. */
class AmazonSignIn(private val context: Context, private val url: String, title: String, note: String,
                   private val deliver: (String?) -> Unit) {
  companion object {
    fun isAmazonPath(url: String, prefix: String): Boolean {
      val uri = Uri.parse(url)
      return uri.scheme == "https" && uri.host == "www.amazon.com" &&
        (uri.port == -1 || uri.port == 443) && uri.userInfo == null &&
        uri.path?.startsWith(prefix) == true
    }
  }
  private val dialog = object : Dialog(context, android.R.style.Theme_Material_NoActionBar) {
    @Deprecated("Legacy Back fallback")
    override fun onBackPressed() { back() }
  }
  private val web = WebView(context)
  private var finished = false
  private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
  private fun finish(redirect: String?, notify: Boolean = true) {
    if (finished) return
    finished = true
    web.stopLoading()
    dialog.dismiss()
    web.removeAllViews()
    web.destroy()
    if (notify) deliver(redirect)
  }
  fun close(notify: Boolean = true) = finish(null, notify)
  private fun back() { if (web.canGoBack()) web.goBack() else close() }
  private fun intercept(url: String): Boolean {
    if (finished) return true
    if (isAmazonPath(url, "/ap/maplanding")) { finish(url); return true }
    return Uri.parse(url).scheme != "https"
  }
  init {
    val bg = Color.parseColor("#0f1115")
    val text = Color.parseColor("#e7e9ee")
    val muted = Color.parseColor("#9aa3b2")
    val root = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }
    val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(8)) }
    val close = Button(context).apply {
      this.text = "\u2715"; setTextColor(text); contentDescription = title + " \u00b7 \u2715"
      setBackgroundColor(Color.parseColor("#171a21")); setOnClickListener { close() }
    }
    header.addView(close, LinearLayout.LayoutParams(dp(44), dp(44)))
    val heading = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
    heading.addView(TextView(context).apply { this.text = title; textSize = 16f; setTextColor(text); gravity = Gravity.CENTER })
    heading.addView(TextView(context).apply {
      this.text = "\uD83D\uDD12 amazon.com"; textSize = 12f; setTextColor(muted); gravity = Gravity.CENTER
      setPadding(dp(8), dp(4), dp(8), dp(4))
      setBackgroundColor(Color.parseColor("#171a21"))
    })
    header.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
    header.addView(View(context), LinearLayout.LayoutParams(dp(44), dp(44)))
    fun border() = View(context).apply { setBackgroundColor(Color.parseColor("#2a2f3a")) }
    root.addView(header)
    root.addView(border(), LinearLayout.LayoutParams(-1, dp(1)))
    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
      setSupportMultipleWindows(false)
    }
    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // Only the main-frame redirect can complete sign-in.
        if (!request.isForMainFrame) return request.url.scheme != "https"
        return intercept(request.url.toString())
      }
      @Deprecated("Legacy WebView fallback")
      override fun shouldOverrideUrlLoading(view: WebView, url: String) = intercept(url)
      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        if (intercept(url) && !finished) view.stopLoading()
      }
    }
    root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
    root.addView(border(), LinearLayout.LayoutParams(-1, dp(1)))
    root.addView(TextView(context).apply {
      this.text = note; textSize = 12f; setTextColor(muted); setPadding(dp(16), dp(12), dp(16), dp(12))
    })
    dialog.setContentView(root)
    dialog.setCanceledOnTouchOutside(false)
    dialog.setOnDismissListener { close() }
    dialog.setOnKeyListener { _, key, event ->
      if (key == KeyEvent.KEYCODE_BACK) { if (event.action == KeyEvent.ACTION_UP) back(); true } else false
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    dialog.window?.apply {
      androidx.core.view.WindowCompat.setDecorFitsSystemWindows(this, false)
      setBackgroundDrawableResource(android.R.color.transparent)
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
      statusBarColor = bg; navigationBarColor = bg
    }
  }
  fun show() {
    dialog.show()
    dialog.window?.setLayout(-1, -1)
    ViewCompat.requestApplyInsets(web.parent as View)
    if (Build.VERSION.SDK_INT >= 33) {
      dialog.onBackInvokedDispatcher.registerOnBackInvokedCallback(
        android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
      ) { back() }
    }
    web.loadUrl(url)
  }
}
