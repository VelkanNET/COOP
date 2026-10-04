import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  updateProfile,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDocs,
  getFirestore,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  deleteDoc,
  setDoc,
  where,
  startAfter
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const config = {
  apiKey: "AIzaSyCLBoUbZscTPM2UroAm-VQzkM0jO2_S2Rs",
  authDomain: "coop-daf1b.firebaseapp.com",
  projectId: "coop-daf1b",
  storageBucket: "coop-daf1b.firebasestorage.app",
  messagingSenderId: "982176801029",
  appId: "1:982176801029:web:8420b7e7626fcdb18e976c",
  measurementId: "G-W1F0H56CN8"
};

const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app, "default");
const billingWorkerUrl = "";
const staffWorkerUrl = billingWorkerUrl;
let profileUnsubscribe = null;
let postsUnsubscribe = null;
let coopsUnsubscribe = null;
let ticketsUnsubscribe = null;
let usersUnsubscribe = null;
let auditUnsubscribe = null;
const postAuthorUnsubscribes = new Map();
const postAuthors = new Map();

async function callBillingWorker(path, body = {}) {
  if (!billingWorkerUrl) {
    throw new Error("A cobrança está aguardando a configuração do endereço do Cloudflare Worker.");
  }
  const user = auth.currentUser;
  if (!user) throw new Error("Entre na sua conta antes de continuar.");
  const response = await fetch(`${billingWorkerUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await user.getIdToken()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Não foi possível processar a cobrança.");
  return result;
}

async function ensureUser(user) {
  const ref = doc(db, "users", user.uid);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists()) {
      const profile = snapshot.data();
      if (!profile.name || profile.name === user.email) {
        profile.name = user.displayName || user.email.split("@")[0];
        transaction.update(ref, { name: profile.name });
      }
      return profile;
    }

    const profile = {
      email: user.email,
      name: user.displayName || user.email.split("@")[0],
      pic: user.photoURL || "",
      role: "user",
      plan: "free",
      status: "ok",
      fr: [],
      sc: []
    };
    transaction.set(ref, profile);
    return profile;
  });
}

window.coopFirebase = {
  ensureUser,
  watchProfile(uid, callback) {
    if (profileUnsubscribe) profileUnsubscribe();
    profileUnsubscribe = onSnapshot(
      doc(db, "users", uid),
      snapshot => callback(snapshot.exists() ? snapshot.data() : null, null),
      error => callback(null, error)
    );
    return profileUnsubscribe;
  },
  watchUserByEmail(email, callback) {
    return onSnapshot(
      query(collection(db, "users"), where("email", "==", email), limit(1)),
      snapshot => {
        const profileSnapshot = snapshot.docs[0];
        callback(profileSnapshot ? { ...profileSnapshot.data(), uid: profileSnapshot.id } : null, null);
      },
      error => callback(null, error)
    );
  },
  watchCoops(email, isStaff, callback) {
    if (coopsUnsubscribe) coopsUnsubscribe();
    const coopsQuery = isStaff
      ? collection(db, "coops")
      : query(collection(db, "coops"), where("members", "array-contains", email));
    coopsUnsubscribe = onSnapshot(
      coopsQuery,
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), id: item.id })), null),
      error => callback(null, error)
    );
    return coopsUnsubscribe;
  },
  async saveCoops(coops) {
    await Promise.all(coops.map(({ id, ...coop }) => setDoc(doc(db, "coops", id), coop, { merge: true })));
  },
  watchStaffUsers(callback) {
    if (usersUnsubscribe) usersUnsubscribe();
    usersUnsubscribe = onSnapshot(
      collection(db, "users"),
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), uid: item.id })), null),
      error => callback(null, error)
    );
    return usersUnsubscribe;
  },
  watchStaffAudit(callback) {
    if (auditUnsubscribe) auditUnsubscribe();
    auditUnsubscribe = onSnapshot(
      query(collection(db, "audit"), orderBy("t", "desc"), limit(200)),
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), id: item.id })), null),
      error => callback(null, error)
    );
    return auditUnsubscribe;
  },
  watchTickets(uid, isStaff, callback) {
    if (ticketsUnsubscribe) ticketsUnsubscribe();
    const ticketsQuery = isStaff
      ? query(collection(db, "tickets"), orderBy("t", "desc"), limit(200))
      : query(collection(db, "tickets"), where("by", "==", uid), limit(100));
    ticketsUnsubscribe = onSnapshot(
      ticketsQuery,
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
        .sort((a, b) => b.t - a.t), null),
      error => callback(null, error)
    );
    return ticketsUnsubscribe;
  },
  async createTicket(ticket) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Entre novamente para abrir um chamado.");
    const now = Date.now();
    const reference = await addDoc(collection(db, "tickets"), {
      by: user.uid,
      email: user.email,
      x: ticket.x,
      t: now,
      d: 0,
      sev: false,
      co: ticket.co || "",
      m: [{ uid: user.uid, f: user.email, x: ticket.x, t: now }]
    });
    return reference.id;
  },
  async addTicketMessage(ticketId, text) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Entre novamente para responder ao chamado.");
    return updateDoc(doc(db, "tickets", ticketId), {
      m: arrayUnion({ uid: user.uid, f: user.email, x: text, t: Date.now() })
    });
  },
  watchProfileScraps(uid, callback) {
    return onSnapshot(
      query(collection(db, "scraps"), where("toUid", "==", uid), limit(100)),
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
        .sort((a, b) => b.t - a.t), null),
      error => callback(null, error)
    );
  },
  async addProfileScrap(uid, text) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Entre novamente para deixar um recado.");
    await addDoc(collection(db, "scraps"), {
      by: user.uid,
      f: user.email,
      toUid: uid,
      x: text,
      t: Date.now()
    });
  },
  async staffCall(path, body = {}) {
    if (!staffWorkerUrl) throw new Error("O Worker administrativo ainda não foi configurado.");
    const user = auth.currentUser;
    if (!user) throw new Error("Entre na conta de desenvolvedor para continuar.");
    const response = await fetch(`${staffWorkerUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await user.getIdToken()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Não foi possível concluir a ação de Staff.");
    return result;
  },
  async deleteAccount(confirmation) {
    return this.staffCall("/api/account/delete", { confirmation });
  },
  watchFollows(uid, callback) {
    let followers = [];
    let following = [];
    let followersCursor = null;
    let followingCursor = null;
    let followersHasMore = false;
    let followingHasMore = false;
    let followerCount = 0;
    let followingCount = 0;
    let followerError = null;
    let followingError = null;
    let profileError = null;
    let followersReady = false;
    let followingReady = false;
    let profileReady = false;
    const emit = () => callback({
      followers,
      following,
      followersCursor,
      followingCursor,
      followersHasMore,
      followingHasMore,
      followerCount,
      followingCount,
      ready: followersReady && followingReady && profileReady,
      error: followerError || followingError || profileError
    });
    const page = type => query(
      collection(db, "users", uid, type),
      orderBy("createdAt", "desc"),
      limit(101)
    );
    const followersUnsubscribe = onSnapshot(
      page("followers"),
      snapshot => {
        const docs = snapshot.docs.slice(0, 100);
        followers = docs.map(item => ({ ...item.data(), uid: item.id }));
        followersCursor = docs.at(-1) || null;
        followersHasMore = snapshot.docs.length > 100;
        followerError = null;
        followersReady = true;
        emit();
      },
      error => {
        followerError = error;
        emit();
      }
    );
    const followingUnsubscribe = onSnapshot(
      page("following"),
      snapshot => {
        const docs = snapshot.docs.slice(0, 100);
        following = docs.map(item => ({ ...item.data(), uid: item.id }));
        followingCursor = docs.at(-1) || null;
        followingHasMore = snapshot.docs.length > 100;
        followingError = null;
        followingReady = true;
        emit();
      },
      error => {
        followingError = error;
        emit();
      }
    );
    const profileUnsubscribe = onSnapshot(
      doc(db, "users", uid),
      snapshot => {
        const profile = snapshot.exists() ? snapshot.data() : {};
        followerCount = Number.isSafeInteger(profile.followerCount) && profile.followerCount >= 0 ? profile.followerCount : 0;
        followingCount = Number.isSafeInteger(profile.followingCount) && profile.followingCount >= 0 ? profile.followingCount : 0;
        profileError = null;
        profileReady = true;
        emit();
      },
      error => {
        profileError = error;
        emit();
      }
    );
    return () => {
      followersUnsubscribe();
      followingUnsubscribe();
      profileUnsubscribe();
    };
  },
  watchFollowState(followerUid, targetUid, callback) {
    return onSnapshot(
      doc(db, "users", followerUid, "following", targetUid),
      snapshot => callback(snapshot.exists(), null),
      error => callback(false, error)
    );
  },
  async loadFollowPage(uid, type, cursor) {
    if (!["followers", "following"].includes(type) || !cursor) {
      throw new Error("Não foi possível carregar a próxima página de perfis.");
    }
    const snapshot = await getDocs(query(
      collection(db, "users", uid, type),
      orderBy("createdAt", "desc"),
      startAfter(cursor),
      limit(101)
    ));
    const docs = snapshot.docs.slice(0, 100);
    return {
      entries: docs.map(item => ({ ...item.data(), uid: item.id })),
      cursor: docs.at(-1) || cursor,
      hasMore: snapshot.docs.length > 100
    };
  },
  async setFollow(target, shouldFollow) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Entre novamente para seguir este perfil.");
    if (!target?.uid || target.uid === user.uid || !target.email) {
      throw new Error("Este perfil não pode ser seguido.");
    }
    const currentRef = doc(db, "users", user.uid);
    const targetRef = doc(db, "users", target.uid);
    const followingRef = doc(db, "users", user.uid, "following", target.uid);
    const followerRef = doc(db, "users", target.uid, "followers", user.uid);
    await runTransaction(db, async transaction => {
      const [currentSnapshot, targetSnapshot, followingSnapshot, followerSnapshot] = await Promise.all([
        transaction.get(currentRef),
        transaction.get(targetRef),
        transaction.get(followingRef),
        transaction.get(followerRef)
      ]);
      if (!currentSnapshot.exists() || !targetSnapshot.exists()) {
        throw new Error("O perfil não existe mais.");
      }
      if (shouldFollow && (followingSnapshot.exists() || followerSnapshot.exists())) return;
      if (!shouldFollow && !followingSnapshot.exists() && !followerSnapshot.exists()) return;

      const currentProfile = currentSnapshot.data();
      const targetProfile = targetSnapshot.data();
      const relation = {
        fromUid: user.uid,
        fromEmail: user.email,
        fromName: currentProfile.name || user.displayName || user.email.split("@")[0],
        toUid: target.uid,
        toEmail: target.email,
        toName: targetProfile.name || target.name || target.email.split("@")[0],
        createdAt: Date.now()
      };
      const followingCount = Number.isSafeInteger(currentProfile.followingCount) ? currentProfile.followingCount : 0;
      const followerCount = Number.isSafeInteger(targetProfile.followerCount) ? targetProfile.followerCount : 0;
      if (shouldFollow) {
        transaction.set(followingRef, relation);
        transaction.set(followerRef, relation);
        transaction.update(currentRef, {
          followingCount: followingCount + 1,
          followingChange: { action: "follow", targetUid: target.uid }
        });
        transaction.update(targetRef, {
          followerCount: followerCount + 1,
          followerChange: { action: "follow", followerUid: user.uid }
        });
      } else {
        transaction.delete(followingRef);
        transaction.delete(followerRef);
        transaction.update(currentRef, {
          followingCount: Math.max(0, followingCount - 1),
          followingChange: { action: "unfollow", targetUid: target.uid }
        });
        transaction.update(targetRef, {
          followerCount: Math.max(0, followerCount - 1),
          followerChange: { action: "unfollow", followerUid: user.uid }
        });
      }
    });
  },
  watchPosts(callback) {
    if (postsUnsubscribe) postsUnsubscribe();
    for (const unsubscribe of postAuthorUnsubscribes.values()) unsubscribe();
    postAuthorUnsubscribes.clear();
    postAuthors.clear();
    let currentPosts = [];
    const emitPosts = (error = null, authorError = null) => {
      callback(currentPosts, error, [...postAuthors.values()], authorError);
    };
    postsUnsubscribe = onSnapshot(
      query(collection(db, "posts"), orderBy("t", "desc"), limit(100)),
      snapshot => {
        currentPosts = snapshot.docs.map(postSnapshot => {
        const post = postSnapshot.data();
        return {
          ...post,
          id: postSnapshot.id,
          t: typeof post.t === "number" ? post.t : post.t.toMillis(),
          v: post.views || 0,
          l: post.likes || [],
          c: post.comments || []
        };
        });
        const authorUids = new Set(currentPosts.map(post => post.uid).filter(Boolean));
        for (const [uid, unsubscribe] of postAuthorUnsubscribes) {
          if (!authorUids.has(uid)) {
            unsubscribe();
            postAuthorUnsubscribes.delete(uid);
            postAuthors.delete(uid);
          }
        }
        emitPosts();
        for (const uid of authorUids) {
          if (postAuthorUnsubscribes.has(uid)) continue;
          const unsubscribe = onSnapshot(
            doc(db, "users", uid),
            profileSnapshot => {
              if (!profileSnapshot.exists()) {
                postAuthors.delete(uid);
              } else {
                const profile = profileSnapshot.data();
                postAuthors.set(uid, {
                  uid,
                  email: profile.email,
                  name: profile.name || profile.email,
                  pic: profile.pic || "",
                  bio: profile.bio || "",
                  links: profile.links || "",
                  linkedin: profile.linkedin || "",
                  cv: profile.cv || "",
                  port: profile.port || "",
                  phone: profile.phone || "",
                  plan: profile.plan || "free",
                  role: profile.email === "negocios.wagnermarques@gmail.com" ? "staff" : "user"
                });
              }
              emitPosts();
            },
            error => emitPosts(null, error)
          );
          postAuthorUnsubscribes.set(uid, unsubscribe);
        }
      },
      error => emitPosts(error)
    );
    return postsUnsubscribe;
  },
  async createPost(post) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Entre novamente para publicar.");
    if (post.i && post.i.length > 750_000) {
      throw new Error("A imagem ficou muito grande para salvar. Escolha uma imagem menor.");
    }
    const reference = await addDoc(collection(db, "posts"), {
      uid: user.uid,
      by: user.email,
      t: Date.now(),
      x: post.x,
      i: post.i || "",
      likes: [],
      comments: [],
      views: 0
    });
    return reference.id;
  },
  togglePostLike(postId, liked) {
    const user = auth.currentUser;
    if (!user || !user.email) return Promise.reject(new Error("Entre novamente para curtir."));
    return updateDoc(doc(db, "posts", postId), {
      likes: liked ? arrayRemove(user.email) : arrayUnion(user.email)
    });
  },
  addPostComment(postId, text) {
    const user = auth.currentUser;
    if (!user || !user.email) return Promise.reject(new Error("Entre novamente para comentar."));
    return updateDoc(doc(db, "posts", postId), {
      comments: arrayUnion({ uid: user.uid, f: user.email, x: text, t: Date.now() })
    });
  },
  recordPostView(postId) {
    return updateDoc(doc(db, "posts", postId), { views: increment(1) });
  },
  deletePost(postId) {
    return deleteDoc(doc(db, "posts", postId));
  },
  saveProfile(profile) {
    const user = auth.currentUser;
    if (!user) return Promise.reject(new Error("É necessário entrar novamente."));
    const name = profile.name.trim();
    if (!name || name.includes("@")) return Promise.reject(new Error("Escolha um nome de perfil que não seja um email."));
    return Promise.all([
      updateProfile(user, { displayName: name }),
      updateDoc(doc(db, "users", user.uid), {
      name,
      pic: profile.pic || "",
      bio: profile.bio || "",
      links: profile.links || "",
      linkedin: profile.linkedin || "",
      cv: profile.cv || "",
      port: profile.port || "",
      phone: profile.phone || ""
      })
    ]);
  },
  async startSubscription(planKey) {
    const result = await callBillingWorker("/api/subscriptions", { planKey });
    return result.checkoutUrl;
  },
  async cancelSubscription() {
    const result = await callBillingWorker("/api/subscriptions/cancel");
    return result.cancelled;
  },
  async signIn() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await setPersistence(auth, browserLocalPersistence);
    return signInWithPopup(auth, provider);
  },
  signOut() {
    return signOut(auth);
  },
  watchAuth(callback) {
    return onAuthStateChanged(
      auth,
      user => callback(user, null),
      error => callback(null, error)
    );
  }
};
window.resolveCoopFirebase();
