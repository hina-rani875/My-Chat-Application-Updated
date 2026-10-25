# Glide-Chat — Presentation Guide

## One-line pitch
A real-time chat app where you just share a link: everyone who opens it joins the same room and chats instantly — text, photos, voice, polls, stickers and more.

## Demo script (3 minutes)
1. **Landing page** – scroll to show the animations, tap *Sign up*. After login a welcome splash plays.
2. **Share a room** – tap **🔗 Send link**, open it in a second browser/phone and sign up a second account.
3. **Real-time chat** – send a message; it appears instantly on the other screen. Type "Congratulations 🎉" → confetti on both screens.
4. **Reactions** – tap a message → pick ❤️ / 🎉 (floating emoji + confetti). Try **Reply**, **Copy**, **Delete**.
5. **Voice message** – tap 🎤, speak, tap again. Show the waveform player and the 1× / 1.5× / 2× speed.
6. **Photo** – 📎 → preview with caption → send. Tap the photo for full-screen view.
7. **＋ menu** – **📊 Poll** (live animated bars), **😎 Stickers**, **📍 Location**, **🔍 Search chat**.
8. **Status** – post a status, choose who can see it (Everyone / Favourites / Only… / Except…). The viewer sees 👁 views, ❤ likes and can copy the status link.
9. **Settings → Appearance** – switch colour theme (Sunset, Ocean, Forest, Violet, Rose) and chat wallpaper (Dots, Plain, Aurora, Stars).
10. **Extras** – groups & communities, QR code, chat lock (PIN), favourites, archive, built-in AI helper.

## Technology
HTML + CSS + vanilla JS (ES modules) · Firebase Authentication + Firestore (real-time onSnapshot) · Cloudinary for media (with automatic fallback to inline storage).

## Important
- Publish the Firestore Rules from RULES.txt, otherwise messages will not be sent.
- Add your Netlify domain to Firebase → Authentication → Authorized domains.
- Lock / Favourite / Archive / Appearance are stored on the current device.
