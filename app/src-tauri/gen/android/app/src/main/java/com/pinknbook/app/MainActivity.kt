package com.pinknbook.app

import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.graphics.Rect
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

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

  // Native-only entry points for wrap-up pictures (src-tauri/src/wrap_export.rs). Both return the
  // place on success ("" once the share sheet is open) or "!" and the reason on failure.

  /** Saves a PNG to the Photos gallery, in Pictures/pntome. Needs Android 10 (scoped storage); older phones can share instead. */
  @androidx.annotation.Keep
  fun saveImage(bytes: ByteArray, name: String): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "!Saving to Photos needs Android 10 or newer"
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, name)
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/pntome")
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
      ?: return "!The gallery did not accept the picture"
    return try {
      (contentResolver.openOutputStream(uri) ?: throw IOException("The gallery gave no place to write")).use { it.write(bytes) }
      // Pending until the bytes are in: the gallery shows no half-written picture.
      contentResolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
      "Pictures/pntome/$name"
    } catch (e: Exception) {
      contentResolver.delete(uri, null, null)
      "!" + (e.message ?: e.javaClass.simpleName)
    }
  }

  /** Opens the share sheet for a PNG: a file in the cache, handed out through the FileProvider of the manifest. */
  @androidx.annotation.Keep
  fun shareImage(bytes: ByteArray, name: String): String {
    return try {
      val dir = File(cacheDir, "wrap").apply { mkdirs() }
      // Only the picture being shared is kept.
      dir.listFiles()?.forEach { it.delete() }
      val file = File(dir, name).apply { writeBytes(bytes) }
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri(name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivity(Intent.createChooser(send, null))
      ""
    } catch (e: Exception) {
      "!" + (e.message ?: e.javaClass.simpleName)
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
