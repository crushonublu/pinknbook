package com.pinknbook.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@androidx.annotation.Keep
object SecureStore {
  private const val ALIAS = "pntome-creds"
  private fun prefs(context: Context) = context.getSharedPreferences("pntome_secure", Context.MODE_PRIVATE)
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(false).build())
    }.generateKey()
  }
  @JvmStatic @Synchronized fun put(context: Context, name: String, value: String) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
    check(prefs(context).edit().putString(name, packed).commit()) { "Secure storage write failed" }
  }
  @JvmStatic @Synchronized fun get(context: Context, name: String): String? {
    val packed = prefs(context).getString(name, null) ?: return null
    val parts = packed.split(":", limit = 2)
    check(parts.size == 2) { "Invalid secure storage" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
    }
    return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
  }
  @JvmStatic @Synchronized fun remove(context: Context, name: String) {
    check(prefs(context).edit().remove(name).commit()) { "Secure storage removal failed" }
  }
}
