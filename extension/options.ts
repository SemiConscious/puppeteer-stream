import { io, Socket } from 'socket.io-client';

export type RecordingOptions = {
	video: boolean;
	audio: boolean;
	videoConstraints?: chrome.tabCapture.MediaStreamConstraint;
	audioConstraints?: chrome.tabCapture.MediaStreamConstraint;
	webSocketUrl: string;
	sessionId: string;
	peerConnectionConfig: any
};

enum IoState {
	DISCONNECTED = 1,
	CONNECTING,
	CONNECTED,
	ERROR
}

class SocketIOClient {

	private client: Socket
	private ioState: IoState = IoState.DISCONNECTED;

	constructor(
		private sessionId: string,
		private webSocketUrl: string,
		private handleWebsocketMessage: (msg: any) => void
	) { }

	async start() {

		this.client = io(this.webSocketUrl, {});

		await new Promise<void>(((resolve, reject) => {

			const timeout = setTimeout((() => {
				console.warn(`Connect to ${this.webSocketUrl} timed out`);
				this.ioState = IoState.DISCONNECTED;
				this.client.disconnect();
				reject()
			}).bind(this), 1000);

			this.client.on('connect', () => {
				console.log(`connected to ${this.webSocketUrl}`);
				this.ioState = IoState.CONNECTED;
				clearTimeout(timeout);
				resolve()
			});
		}).bind(this));

		this.client.on('connect_failed', ((error) => {
			console.warn(`Connect failed on ${this.webSocketUrl}`, error);
			this.ioState = IoState.DISCONNECTED;
		}).bind(this));

		this.client.on('connect_error', ((error) => {
			console.log(`Connect error on ${this.webSocketUrl}`, error);
			this.ioState = IoState.ERROR;
		}).bind(this));

		this.client.on('disconnect', ((reason, details) => {
			console.warn(`${this.webSocketUrl} disconnected`, reason, details || '');
			this.ioState = IoState.DISCONNECTED;
		}).bind(this));

		this.client.on('gmeetapi:statusupdate', ((msg: any) => {
			switch (msg.code) {
				case 'WEBRTC': {
					this.handleWebsocketMessage(msg.msg);
					break;
				}
			}
			console.log(msg);
		}).bind(this));

		await this.requestJoinRoom(true);
	}

	async finish() {
		await this.requestJoinRoom(false);
		this.client.disconnect();
	}

	async requestWebRTC(message: any): Promise<boolean | null> {
		if (this.ioState == IoState.CONNECTED) {
			return new Promise((resolve) => {
				this.client.emit('gmeetapi:webrtc', { message, sessionId: this.sessionId },
					(response: any) => {
						if (response.status != 'Ok') {
							console.warn(`requestWebRTC failed: ${response.statusText}`);
							resolve(false);
						} else {
							//console.log(`requestWebRTC request accepted`);
							resolve(true);
						}
					}
				);
			});
		} else {
			console.warn('requestRestartApp: not connected to agent endpoint');
		}
		return null;
	}

	async requestJoinRoom(enable: boolean): Promise<boolean | null> {
		if (this.ioState == IoState.CONNECTED) {
			return new Promise((resolve) => {
				this.client.emit('gmeetapi:joinroom', { id: this.sessionId, enable },
					(response: any) => {
						if (response.status != 'Ok') {
							console.warn(`requestJoinRoom failed: ${response.statusText}`);
							resolve(false);
						} else {
							//console.log(`requestJoinRoom request accepted`);
							resolve(true)
						}
					}
				);
			});
		} else {
			console.warn('requestJoinRoom: not connected to agent endpoint');
		}
		return null;
	}
}

class Session {

	private stream?: MediaStream
	private client: SocketIOClient
	private peerConnection: RTCPeerConnection

	constructor(
		private options: RecordingOptions,
		private handleSessionClose: (sessionId: string) => void
	) {
		const { sessionId, webSocketUrl, peerConnectionConfig } = this.options;
		this.client = new SocketIOClient(sessionId, webSocketUrl, this.handleWebsocketMessage.bind(this));
		this.peerConnection = new RTCPeerConnection(peerConnectionConfig);
	}

	async start() {

		const {
			video,
			audio,
			videoConstraints,
			audioConstraints,
		} = this.options

		await this.client.start();

		this.stream = await new Promise<MediaStream>((resolve, reject) => {
			chrome.tabCapture.capture(
				{
					audio,
					video,
					audioConstraints,
					videoConstraints,
				},
				(stream) => {
					if (chrome.runtime.lastError || !stream) {
						reject(chrome.runtime.lastError?.message);
					} else {
						resolve(stream);
					}
				}
			);
		});

		// Handle ICE candidates
		this.peerConnection.onicecandidate = ((event: RTCPeerConnectionIceEvent) => {
			this.client.requestWebRTC({ type: 'candidate', candidate: event.candidate || null });
		}).bind(this);

		// handle close event
		this.peerConnection.onconnectionstatechange = ((_ev) => {
			switch (this.peerConnection.connectionState) {
				case "new":
				case "connecting":
				case "connected":
					break;
				default:
					console.log(`[PUPPETEER_STREAM] connectionState: ${this.peerConnection.connectionState} - closing`);
					this.handleSessionClose(this.options.sessionId);
					break;
			}
		}).bind(this);

		// Add the media stream tracks to the peer connection
		this.stream.getTracks().forEach(((track: MediaStreamTrack) => {
			this.peerConnection.addTrack(track, this.stream);
		}).bind(this));

		// Create and send an offer - this starts the negotiation
		const offer = await this.peerConnection.createOffer()
		this.peerConnection.setLocalDescription(offer);
		this.client.requestWebRTC({ type: 'offer', offer });
	}

	async finish() {
		this.stream?.getTracks().forEach((track) => {
			track.stop();
		});
		this.peerConnection.close();
		await this.client.finish();
	}

	handleWebsocketMessage(message: any) {
		if (this.peerConnection) {
			if (message.type === 'answer') {
				this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
			} else if (message.type === 'candidate') {
				if (message.candidate) {
					this.peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
				} else {
					this.peerConnection.addIceCandidate(null);
				}
			}
		}
	}
}

const sessions: Record<number, Session> = {}

const START_RECORDING = async (options: RecordingOptions) => {

	console.log(
		"[PUPPETEER_STREAM] START_RECORDING",
		JSON.stringify(options)
	);

	const session = new Session(options, (sessionId: string) => {
		if (sessionId in sessions) {
			session.finish()
			delete sessions[sessionId];
		}
	});

	sessions[options.sessionId] = session;

	await session.start();
};

const STOP_RECORDING = async (sessionId: string) => {
	console.log("[PUPPETEER_STREAM] STOP_RECORDING", sessionId);
	if (sessionId in sessions) {
		const session = sessions[sessionId];
		session.finish()
		delete sessions[sessionId];
	}
};

globalThis.START_RECORDING = START_RECORDING;
globalThis.STOP_RECORDING = STOP_RECORDING;
