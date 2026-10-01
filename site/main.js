(() => {
  "use strict";

  const CONFIG = window.SKYHIGH_RADIO_CONFIG || {};
  const SIGNALING_URL = CONFIG.SIGNALING_URL || "";
  const MAX_PARTICIPANTS = 19;
  const SUGGESTED_FREQUENCIES = ["118.10", "119.70", "121.50", "123.45", "125.20", "126.00", "129.40", "131.20", "133.40", "134.80", "135.50", "136.20", "251.20", "255.00", "COM1", "COM2"];
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

  const frequencyInput = document.getElementById("frequency");
  const tuneButton = document.getElementById("tuneButton");
  const leaveButton = document.getElementById("leaveButton");
  const muteButton = document.getElementById("muteButton");
  const pttMode = document.getElementById("pttMode");
  const pttButton = document.getElementById("pttButton");
  const statusElement = document.getElementById("status");
  const currentFrequencyElement = document.getElementById("currentFrequency");
  const participantCountElement = document.getElementById("participantCount");
  const frequencyList = document.getElementById("frequencyList");

  let socket = null;
  let localStream = null;
  let currentChannel = "";
  let isMuted = false;
  let isTransmitting = false;
  let joinedPeerIds = new Set();
  const peers = new Map();
  const pendingIceCandidates = new Map();

  const normaliseFrequency = (value) => value.trim().toUpperCase().replace(/\s+/g, "");

  function setStatus(message, kind = "") {
    statusElement.textContent = message;
    statusElement.className = `status ${kind}`.trim();
  }

  function updateControls() {
    const tuned = Boolean(currentChannel);
    leaveButton.disabled = !tuned;
    muteButton.disabled = !tuned;
    pttMode.disabled = !tuned;
    pttButton.disabled = !tuned || isMuted || !pttMode.checked;
    muteButton.textContent = isMuted ? "Unmute" : "Mute";
    pttButton.textContent = isTransmitting ? "Transmitting" : "Hold to transmit";
    pttButton.classList.toggle("transmitting", isTransmitting);
    participantCountElement.textContent = String(joinedPeerIds.size + (tuned ? 1 : 0));
  }

  function renderSuggestions() {
    for (const frequency of SUGGESTED_FREQUENCIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "frequency-chip";
      button.textContent = frequency;
      button.addEventListener("click", () => {
        frequencyInput.value = frequency;
        frequencyInput.focus();
      });
      frequencyList.appendChild(button);
    }
  }

  async function getMicrophone() {
    if (localStream) return localStream;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone capture.");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
      video: false
    });
    applyMicrophoneState();
    return localStream;
  }

  function applyMicrophoneState() {
    if (!localStream) return;
    const enabled = !isMuted && (!pttMode.checked || isTransmitting);
    for (const track of localStream.getAudioTracks()) track.enabled = enabled;
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function createPeerConnection(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);
    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 2 });

    peerConnection.onicecandidate = ({ candidate }) => {
      if (candidate) send({ type: "signal", target: peerId, data: { type: "ice-candidate", candidate } });
    };

    peerConnection.ontrack = ({ streams }) => {
      const remoteStream = streams[0];
      if (!remoteStream) return;
      let audio = document.getElementById(`remote-audio-${peerId}`);
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = `remote-audio-${peerId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = remoteStream;
      audio.play().catch(() => setStatus("Audio received. Tap the page if playback was blocked."));
    };

    peerConnection.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(peerConnection.connectionState)) removePeer(peerId);
      if (peerConnection.connectionState === "connected") setStatus(`Connected on ${currentChannel}`, "good");
    };

    if (localStream) for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);
    peers.set(peerId, peerConnection);
    return peerConnection;
  }

  async function makeOffer(peerId) {
    const peerConnection = createPeerConnection(peerId);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    send({ type: "signal", target: peerId, data: { type: "offer", sdp: peerConnection.localDescription } });
  }

  async function addQueuedCandidates(peerId, peerConnection) {
    for (const candidate of pendingIceCandidates.get(peerId) || []) await peerConnection.addIceCandidate(candidate);
    pendingIceCandidates.delete(peerId);
  }

  async function receiveSignal(from, data) {
    if (!data?.type) return;
    const peerConnection = createPeerConnection(from);

    if (data.type === "offer") {
      await peerConnection.setRemoteDescription(data.sdp);
      await addQueuedCandidates(from, peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      send({ type: "signal", target: from, data: { type: "answer", sdp: peerConnection.localDescription } });
      return;
    }

    if (data.type === "answer") {
      await peerConnection.setRemoteDescription(data.sdp);
      await addQueuedCandidates(from, peerConnection);
      return;
    }

    if (data.type === "ice-candidate" && data.candidate) {
      if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(data.candidate);
      else pendingIceCandidates.set(from, [...(pendingIceCandidates.get(from) || []), data.candidate]);
    }
  }

  function removePeer(peerId) {
    const peerConnection = peers.get(peerId);
    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.close();
      peers.delete(peerId);
    }
    pendingIceCandidates.delete(peerId);
    joinedPeerIds.delete(peerId);
    const audio = document.getElementById(`remote-audio-${peerId}`);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
    updateControls();
  }

  function clearPeers() {
    for (const peerId of [...peers.keys()]) removePeer(peerId);
    joinedPeerIds.clear();
  }

  async function handleServerMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    if (message.type === "welcome") {
      joinedPeerIds = new Set(message.peers || []);
      updateControls();
      for (const peerId of message.peers || []) await makeOffer(peerId);
      setStatus(`Tuned to ${currentChannel}`, "good");
      return;
    }
    if (message.type === "peer-joined") {
      joinedPeerIds.add(message.peerId);
      updateControls();
      return;
    }
    if (message.type === "peer-left") {
      removePeer(message.peerId);
      return;
    }
    if (message.type === "signal") {
      await receiveSignal(message.from, message.data);
      return;
    }
    if (message.type === "error") setStatus(message.message || "Signaling error.", "bad");
  }

  async function tune() {
    const channel = normaliseFrequency(frequencyInput.value);
    if (!channel) {
      setStatus("Enter a frequency or channel name first.", "bad");
      frequencyInput.focus();
      return;
    }
    if (!SIGNALING_URL || SIGNALING_URL.includes("YOUR_SUBDOMAIN")) {
      setStatus("Set the deployed Worker URL in site/config.js first.", "bad");
      return;
    }
    if (currentChannel === channel && socket?.readyState === WebSocket.OPEN) return;

    await leave();
    try {
      tuneButton.disabled = true;
      setStatus("Requesting microphone permission…");
      await getMicrophone();
      currentChannel = channel;
      currentFrequencyElement.textContent = channel;
      isMuted = false;
      isTransmitting = false;
      pttMode.checked = true;
      applyMicrophoneState();
      updateControls();

      const workerUrl = new URL(SIGNALING_URL);
      if (workerUrl.protocol === "https:") workerUrl.protocol = "wss:";
      workerUrl.searchParams.set("channel", channel);
      setStatus(`Connecting to ${channel}…`);
      socket = new WebSocket(workerUrl.toString());
      socket.addEventListener("open", () => setStatus(`Joining ${channel}…`));
      socket.addEventListener("message", (event) => handleServerMessage(event).catch((error) => {
        console.error(error);
        setStatus("A signaling message could not be processed.", "bad");
      }));
      socket.addEventListener("close", () => {
        if (currentChannel) setStatus("Disconnected from signaling. Leave and tune again.", "bad");
      });
      socket.addEventListener("error", () => setStatus("Could not connect to the signaling service.", "bad"));
    } catch (error) {
      console.error(error);
      currentChannel = "";
      currentFrequencyElement.textContent = "—";
      setStatus(error.name === "NotAllowedError" ? "Microphone access was denied." : `Could not start radio: ${error.message || "unknown error"}`, "bad");
      updateControls();
    } finally {
      tuneButton.disabled = false;
    }
  }

  async function leave() {
    isTransmitting = false;
    applyMicrophoneState();
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "Leaving channel");
      socket = null;
    }
    clearPeers();
    currentChannel = "";
    currentFrequencyElement.textContent = "—";
    setStatus("Not tuned");
    updateControls();
  }

  function setTransmit(active) {
    if (!currentChannel || isMuted || !pttMode.checked || active === isTransmitting) return;
    isTransmitting = active;
    applyMicrophoneState();
    updateControls();
  }

  tuneButton.addEventListener("click", tune);
  leaveButton.addEventListener("click", leave);
  frequencyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") tune(); });
  muteButton.addEventListener("click", () => {
    isMuted = !isMuted;
    if (isMuted) isTransmitting = false;
    applyMicrophoneState();
    updateControls();
  });
  pttMode.addEventListener("change", () => {
    isTransmitting = false;
    applyMicrophoneState();
    updateControls();
  });
  pttButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pttButton.setPointerCapture?.(event.pointerId);
    setTransmit(true);
  });
  pttButton.addEventListener("pointerup", () => setTransmit(false));
  pttButton.addEventListener("pointercancel", () => setTransmit(false));
  pttButton.addEventListener("pointerleave", () => setTransmit(false));
  window.addEventListener("keydown", (event) => {
    const typing = document.activeElement === frequencyInput || document.activeElement?.tagName === "TEXTAREA";
    if (event.code === "Space" && !typing && !event.repeat) {
      event.preventDefault();
      setTransmit(true);
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      setTransmit(false);
    }
  });
  window.addEventListener("beforeunload", () => { if (socket) socket.close(); });

  renderSuggestions();
  updateControls();
})();
