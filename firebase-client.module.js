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
  getDoc,
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
  messagingSenderId: "982176801029",
  appId: "1:982176801029:web:8420b7e7626fcdb18e976c",
  measurementId: "G-W1F0H56CN8"
};

const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app, "default");
const billingWorkerUrl = "https://coop-billing.coop-daf1b.workers.dev";
const staffWorkerUrl = billingWorkerUrl;
let profileUnsubscribe = null;
let postsUnsubscribe = null;
let coopsUnsubscribe = null;
let coopFeedUnsubscribe = null;
let coopMessagesUnsubscribe = null;
let ticketsUnsubscribe = null;
let usersUnsubscribe = null;
let auditUnsubscribe = null;
let suffixesUnsubscribe = null;
const postAuthorUnsubscribes = new Map();
const postAuthors = new Map();
const ownerProfileCache = new Map();
const loadedAssetUrls = new Map();

async function readUserByEmail(email) {
  const result = await getDocs(query(collection(db, "users"), where("email", "==", email), limit(1)));
  const profile = result.docs[0];
  return profile ? { uid: profile.id, ...profile.data() } : null;
}

function effectivePlan(profile) {
  const plan = profile?.plan || "free";
  const expiresAt = profile?.planExpiresAt?.toDate?.()?.getTime?.() || 0;
  return plan !== "free" && (profile?.subscriptionStatus === "staff-managed" || expiresAt > Date.now())
    ? plan
    : "free";
}

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function loadAsset(assetId) {
  if (!/^[a-f0-9-]{36}$/i.test(assetId)) throw new Error("Identificador de arquivo inválido.");
  if (loadedAssetUrls.has(assetId)) return loadedAssetUrls.get(assetId);
  const assetRef = doc(db, "assets", assetId);
  const snapshot = await getDoc(assetRef);
  if (!snapshot.exists() || !snapshot.data().ready) {
    throw new Error("O arquivo não existe ou ainda não terminou de enviar.");
  }
  const metadata = snapshot.data();
  if (!Number.isInteger(metadata.size) || metadata.size < 0 || metadata.size > 10 * 1024 * 1024
      || !Number.isInteger(metadata.chunkCount) || metadata.chunkCount < 1 || metadata.chunkCount > 20
      || metadata.uploadedBytes !== metadata.size || metadata.uploadedChunks !== metadata.chunkCount) {
    throw new Error("Os dados do arquivo estão inválidos.");
  }
  const chunks = await getDocs(query(
    collection(db, "assets", assetId, "chunks"),
    orderBy("index")
  ));
  if (chunks.size !== metadata.chunkCount) throw new Error("O arquivo está incompleto.");
  const bytes = new Uint8Array(metadata.size);
  let offset = 0;
  chunks.docs.forEach((chunk, index) => {
    const data = chunk.data();
    if (data.index !== index || typeof data.data !== "string") {
      throw new Error("A sequência de partes do arquivo está inválida.");
    }
    const binary = atob(data.data);
    if (offset + binary.length > bytes.length) throw new Error("O tamanho das partes não confere.");
    for (let position = 0; position < binary.length; position += 1) {
      bytes[offset + position] = binary.charCodeAt(position);
    }
    offset += binary.length;
  });
  if (offset !== metadata.size) throw new Error("O arquivo recebido está incompleto.");
  const url = URL.createObjectURL(new Blob([bytes], { type: metadata.contentType }));
  loadedAssetUrls.set(assetId, url);
  return url;
}

async function trimFreeCoopHistory(coopId, coopData) {
  let ownerUid = coopData.ownerUid;
  if (!ownerUid) ownerUid = (await readUserByEmail(coopData.owner))?.uid;
  if (!ownerUid) throw new Error(`Não foi possível identificar o responsável pelo CO-OP ${coopId}.`);
  if (!ownerProfileCache.has(ownerUid)) {
    ownerProfileCache.set(ownerUid, getDoc(doc(db, "users", ownerUid)).then(snapshot => {
      if (!snapshot.exists()) throw new Error("O perfil do responsável pelo CO-OP não foi encontrado.");
      return snapshot.data();
    }));
  }
  const owner = await ownerProfileCache.get(ownerUid);
  if (effectivePlan(owner) !== "free") return;
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000 + 60_000;
  const ref = doc(db, "coops", coopId);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) return;
    const channels = snapshot.data().ch || [];
    const trimmed = channels.map(channel => ({
      ...channel,
      m: (channel.m || []).filter(message => message.t >= cutoff)
    }));
    if (trimmed.some((channel, index) => channel.m.length !== (channels[index].m || []).length)) {
      transaction.update(ref, { ch: trimmed });
    }
  });
}

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
  get billingReady() {
    return Boolean(billingWorkerUrl);
  },
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
      snapshot => {
        const coops = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
        Promise.all(coops.map(coop => trimFreeCoopHistory(coop.id, coop)))
          .then(() => callback(coops, null))
          .catch(error => callback(null, error));
      },
      error => callback(null, error)
    );
    return coopsUnsubscribe;
  },
  async saveCoops(coops) {
    await Promise.all(coops.map(({ id, ...coop }) => setDoc(doc(db, "coops", id), coop, { merge: true })));
  },
  watchCoopFeed(coopId, cutoff, callback) {
    if (coopFeedUnsubscribe) coopFeedUnsubscribe();
    const feed = collection(db, "coops", coopId, "feed");
    const feedQuery = cutoff
      ? query(feed, where("t", ">=", cutoff), orderBy("t", "desc"), limit(100))
      : query(feed, orderBy("t", "desc"), limit(100));
    coopFeedUnsubscribe = onSnapshot(
      feedQuery,
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), id: item.id })).reverse(), null),
      error => callback(null, error)
    );
    return coopFeedUnsubscribe;
  },
  async createCoopPost(coopId, text, asset = null) {
    const user = auth.currentUser;
    if (!user?.email) throw new Error("Entre novamente para publicar no CO-OP.");
    const profile = await getDoc(doc(db, "users", user.uid));
    await addDoc(collection(db, "coops", coopId, "feed"), {
      by: user.uid,
      f: user.email,
      name: (profile.data()?.name || user.displayName || user.email.split("@")[0]).slice(0, 50),
      x: text,
      t: Date.now(),
      assetPath: asset?.path || "",
      assetKind: asset?.kind || ""
    });
  },
  watchCoopMessages(coopId, channelId, cutoff, callback) {
    if (coopMessagesUnsubscribe) coopMessagesUnsubscribe();
    const messages = collection(db, "coops", coopId, "channels", channelId, "messages");
    const messagesQuery = cutoff
      ? query(messages, where("t", ">=", cutoff), orderBy("t", "desc"), limit(200))
      : query(messages, orderBy("t", "desc"), limit(200));
    coopMessagesUnsubscribe = onSnapshot(
      messagesQuery,
      snapshot => callback(snapshot.docs.map(item => ({ ...item.data(), id: item.id })).reverse(), null),
      error => callback(null, error)
    );
    return coopMessagesUnsubscribe;
  },
  async createCoopMessage(coopId, channelId, text, asset = null) {
    const user = auth.currentUser;
    if (!user?.email) throw new Error("Entre novamente para enviar uma mensagem.");
    const profile = await getDoc(doc(db, "users", user.uid));
    await addDoc(collection(db, "coops", coopId, "channels", channelId, "messages"), {
      from: user.uid,
      f: user.email,
      name: (profile.data()?.name || user.displayName || user.email.split("@")[0]).slice(0, 50),
      x: text,
      t: Date.now(),
      kind: asset?.kind || "",
      assetPath: asset?.path || ""
    });
  },
  async uploadAsset(file, kind, coopId = "") {
    const user = auth.currentUser;
    if (!user) throw new Error("Entre novamente para enviar um arquivo.");
    if (!(file instanceof File) || !["profile", "post", "coop"].includes(kind)) {
      throw new Error("Arquivo ou destino inválido.");
    }
    const profileSnapshot = await getDoc(doc(db, "users", user.uid));
    if (!profileSnapshot.exists() || profileSnapshot.data().status !== "ok") {
      throw new Error("A conta não está habilitada para enviar arquivos.");
    }
    let ownerPlan = effectivePlan(profileSnapshot.data());
    if (kind === "coop") {
      const coopSnapshot = await getDoc(doc(db, "coops", coopId));
      if (!coopSnapshot.exists() || !coopSnapshot.data().members?.includes(user.email)) {
        throw new Error("Somente os membros podem enviar arquivos neste CO-OP.");
      }
      let ownerUid = coopSnapshot.data().ownerUid;
      if (!ownerUid) {
        const ownerQuery = await getDocs(query(collection(db, "users"), where("email", "==", coopSnapshot.data().owner), limit(1)));
        ownerUid = ownerQuery.docs[0]?.id;
      }
      if (!ownerUid) throw new Error("Não foi possível identificar o responsável pelo CO-OP.");
      const ownerSnapshot = await getDoc(doc(db, "users", ownerUid));
      if (!ownerSnapshot.exists()) throw new Error("Não foi possível verificar o plano do CO-OP.");
      ownerPlan = effectivePlan(ownerSnapshot.data());
    }
    const limits = { free: 2, basic: 5, standard: 10 };
    const maxBytes = (limits[ownerPlan] || limits.free) * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new Error(`O limite deste plano é ${limits[ownerPlan] || limits.free} MB por arquivo.`);
    }
    if (!["image/", "application/pdf", "text/plain"].some(type => file.type.startsWith(type))) {
      throw new Error("São aceitos arquivos de imagem, PDF ou texto simples.");
    }
    if (kind === "profile" && !file.type.startsWith("image/")) {
      throw new Error("A foto de perfil deve ser uma imagem.");
    }
    if (kind === "post" && !file.type.startsWith("image/")) {
      throw new Error("Publicações aceitam somente imagens como anexo.");
    }
    if (kind === "post" && ownerPlan === "free") {
      throw new Error("No plano Free, publicações não aceitam anexos. Compartilhe mídias usando links do Drive, OneDrive ou YouTube.");
    }
    if (kind === "coop" && ownerPlan === "free" && file.type !== "text/plain") {
      throw new Error("No plano Free, grupos aceitam apenas documentos de texto leves. Use links do Drive, OneDrive ou YouTube para outras mídias.");
    }
    if (!file.size) throw new Error("O arquivo está vazio.");
    const chunkSize = 512 * 1024;
    const chunkCount = Math.ceil(file.size / chunkSize);
    const assetId = crypto.randomUUID();
    const assetRef = doc(db, "assets", assetId);
    await setDoc(assetRef, {
      uid: user.uid,
      email: user.email,
      kind,
      coopId: kind === "coop" ? coopId : "",
      contentType: file.type,
      name: file.name.slice(0, 120),
      size: file.size,
      chunkCount,
      uploadedBytes: 0,
      uploadedChunks: 0,
      createdAt: Date.now(),
      ready: false
    });
    const chunkRefs = [];
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * chunkSize;
        const chunkRef = doc(db, "assets", assetId, "chunks", String(index).padStart(4, "0"));
        const content = bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
        await runTransaction(db, async transaction => {
          const current = await transaction.get(assetRef);
          if (!current.exists() || current.data().ready || current.data().uploadedChunks !== index) {
            throw new Error("O envio das partes do arquivo perdeu sua sequência.");
          }
          const existingChunk = await transaction.get(chunkRef);
          if (existingChunk.exists()) throw new Error("Uma parte duplicada do arquivo foi detectada.");
          transaction.set(chunkRef, {
            index,
            bytes: content.length,
            data: encodeBase64(content)
          });
          transaction.update(assetRef, {
            uploadedBytes: current.data().uploadedBytes + content.length,
            uploadedChunks: index + 1
          });
        });
        chunkRefs.push(chunkRef);
      }
      await updateDoc(assetRef, { ready: true });
    } catch (error) {
      const cleanupErrors = [];
      await Promise.all(chunkRefs.map(chunkRef => deleteDoc(chunkRef).catch(cleanupError => cleanupErrors.push(cleanupError))));
      await deleteDoc(assetRef).catch(cleanupError => cleanupErrors.push(cleanupError));
      if (cleanupErrors.length) {
        throw new Error(`${error.message} O envio parcial não pôde ser limpo: ${cleanupErrors.map(item => item.message).join("; ")}`, { cause: error });
      }
      throw error;
    }
    return { path: assetId, url: `coopasset:${assetId}` };
  },
  loadAsset,
  clearAssetCache() {
    loadedAssetUrls.forEach(url => URL.revokeObjectURL(url));
    loadedAssetUrls.clear();
  },
  async deleteAsset(assetId) {
    if (!/^[a-f0-9-]{36}$/i.test(assetId)) throw new Error("Identificador de arquivo inválido.");
    const assetRef = doc(db, "assets", assetId);
    const snapshot = await getDoc(assetRef);
    if (!snapshot.exists()) return;
    const chunks = await getDocs(collection(db, "assets", assetId, "chunks"));
    await Promise.all(chunks.docs.map(chunk => deleteDoc(chunk.ref)));
    await deleteDoc(assetRef);
    const url = loadedAssetUrls.get(assetId);
    if (url) URL.revokeObjectURL(url);
    loadedAssetUrls.delete(assetId);
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
  watchSuffixes(isStaff, callback) {
    if (suffixesUnsubscribe) suffixesUnsubscribe();
    let betaSeedAttempted = false;
    suffixesUnsubscribe = onSnapshot(
      collection(db, "suffixes"),
      snapshot => {
        const suffixes = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
        callback(suffixes, null);
        if (isStaff && !betaSeedAttempted && !snapshot.docs.some(item => item.id === "beta")) {
          betaSeedAttempted = true;
          setDoc(doc(db, "suffixes", "beta"), {
            label: "Beta",
            color: "#34383d",
            createdAt: Date.now()
          }).catch(error => callback(null, error));
        }
      },
      error => callback(null, error)
    );
    return suffixesUnsubscribe;
  },
  async saveSuffix(suffix) {
    const user = auth.currentUser;
    if (!user) throw new Error("Entre na conta de desenvolvedor para continuar.");
    if (!/^[a-f0-9-]{1,64}$/i.test(suffix.id)
        || typeof suffix.label !== "string"
        || !suffix.label.trim()
        || suffix.label.trim().length > 18
        || !/^#[0-9a-f]{6}$/i.test(suffix.color)) {
      throw new Error("Informe um nome de até 18 caracteres e uma cor hexadecimal válida.");
    }
    await setDoc(doc(db, "suffixes", suffix.id), {
      label: suffix.label.trim(),
      color: suffix.color.toLowerCase(),
      createdAt: Date.now()
    });
  },
  async assignExtraSuffix(uid, suffixId) {
    if (!auth.currentUser) throw new Error("Entre na conta de desenvolvedor para continuar.");
    if (typeof uid !== "string" || !uid
        || (suffixId !== "" && (typeof suffixId !== "string" || !/^[a-f0-9-]{1,64}$/i.test(suffixId)))) {
      throw new Error("Usuário ou sufixo inválido.");
    }
    if (suffixId && !(await getDoc(doc(db, "suffixes", suffixId))).exists()) {
      throw new Error("O sufixo selecionado não existe mais.");
    }
    await updateDoc(doc(db, "users", uid), { extraSuffixId: suffixId || null });
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
    const reference = await addDoc(collection(db, "posts"), {
      uid: user.uid,
      by: user.email,
      t: Date.now(),
      x: post.x,
      i: post.i || "",
      assetId: post.assetId || "",
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
  async deletePost(postId) {
    const reference = doc(db, "posts", postId);
    const snapshot = await getDoc(reference);
    if (!snapshot.exists()) return;
    await deleteDoc(reference);
    if (snapshot.data().assetId) await this.deleteAsset(snapshot.data().assetId);
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
