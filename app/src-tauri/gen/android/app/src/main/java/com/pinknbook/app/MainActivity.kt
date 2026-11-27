package com.pinknbook.app

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Process
import android.graphics.Rect
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

private const val KINDLE_PACKAGE = "com.amazon.kindle"

/**
 * The Kindle app's screens that show a book (or a periodical, article, manga) and the in-book tools
 * (contents, notes, dictionary, search): time on these counts, time in the library or the store does not.
 * Activity names from the manifests of Kindle 8.160 and 14.146 (StandAloneBookReaderActivity, BookReaderActivity…).
 */
private fun isKindleReadingScreen(cls: String): Boolean =
  cls.startsWith("com.amazon.kcp.reader.") ||
    cls.startsWith("com.amazon.kindle.mangaviewer.") ||
    cls.startsWith("com.amazon.article.reader.") ||
    cls.endsWith("ReaderActivity") ||
    cls.endsWith("ReaderSearchActivity")

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

  // Native-only entry point for the Amazon days (src-tauri/src/amazon_days.rs): the cookies of the
  // sign-in web view for www.amazon.com, as a Cookie header. Never logged or stored.
  @androidx.annotation.Keep
  fun amazonCookieHeader(): String =
    android.webkit.CookieManager.getInstance().getCookie("https://www.amazon.com") ?: ""

  // Native-only entry points for the time the Kindle app was on screen (src-tauri/src/kindle_app.rs).

  /** Has the user granted "Usage access" to this app? */
  @androidx.annotation.Keep
  fun hasUsageAccess(): Boolean {
    val ops = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
    } else {
      @Suppress("DEPRECATION")
      ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
    }
    return mode == AppOpsManager.MODE_ALLOWED
  }

  /** Opens the system's Usage access screen, on this app's entry when the phone can show it. */
  @androidx.annotation.Keep
  fun openUsageAccessSettings() {
    try {
      startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:$packageName")))
    } catch (e: Exception) {
      startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
    }
  }

  /**
   * When a book was open in the Kindle app between [fromMs] and [toMs] (epoch milliseconds): a JSON
   * array `[[startMs,endMs],...]`, or "!" and the reason ("!no_access" without Usage access). Only the
   * reading screens count ([isKindleReadingScreen]); they are one session from being resumed until all
   * of them are stopped (Android 10+; paused before), so a dictionary or a tip shown over the page keeps
   * the session going. A session still open at [toMs] ends there; one that began before [fromMs] starts there.
   */
  @androidx.annotation.Keep
  fun kindleForegroundSessions(fromMs: Long, toMs: Long): String {
    if (!hasUsageAccess()) return "!no_access"
    return try {
      val usage = getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return "!no_service"
      val events = usage.queryEvents(fromMs, toMs)
      val event = UsageEvents.Event()
      val sessions = org.json.JSONArray()
      val resumed = HashSet<String>()
      var startedAt = -1L
      // Only a pause before any other Kindle event can belong to a session that began before the window;
      // a stray pause after a closed session is ignored.
      var seenKindle = false
      while (events.hasNextEvent()) {
        events.getNextEvent(event)
        if (event.packageName != KINDLE_PACKAGE) continue
        val screen = event.className ?: ""
        if (!isKindleReadingScreen(screen)) continue
        val type = event.eventType
        // The legacy names (API 21) have the same values as ACTIVITY_RESUMED / ACTIVITY_PAUSED (API 29).
        @Suppress("DEPRECATION")
        val isResume = type == UsageEvents.Event.ACTIVITY_RESUMED || type == UsageEvents.Event.MOVE_TO_FOREGROUND
        // A screen still visible under a dialog is paused but not stopped; ACTIVITY_STOPPED exists from Android 10.
        @Suppress("DEPRECATION")
        val isPause = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) type == UsageEvents.Event.ACTIVITY_STOPPED
          else type == UsageEvents.Event.MOVE_TO_BACKGROUND
        if (isResume) {
          if (resumed.isEmpty()) startedAt = event.timeStamp
          resumed.add(screen)
          seenKindle = true
        } else if (isPause) {
          if (startedAt < 0) {
            if (seenKindle) continue
            // Paused without being resumed in this window: the session began before it.
            startedAt = fromMs; resumed.add(screen)
          }
          seenKindle = true
          resumed.remove(screen)
          if (resumed.isEmpty()) {
            if (event.timeStamp > startedAt) sessions.put(org.json.JSONArray().put(startedAt).put(event.timeStamp))
            startedAt = -1L
          }
        }
      }
      if (startedAt >= 0 && toMs > startedAt) sessions.put(org.json.JSONArray().put(startedAt).put(toMs))
      sessions.toString()
    } catch (e: Exception) {
      "!" + (e.message ?: e.javaClass.simpleName)
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
