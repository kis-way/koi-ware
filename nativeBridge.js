/**
 * 한투앱 WebView JS Bridge 연동 지점.
 *
 * 2026-09-30: 한투 네이티브팀이 실제 브릿지 스펙 문서를 전달함
 * (docs/시스템_오디오_상태_및_햅틱_Bridge_가이드.docx) - 시스템 오디오 상태 확인/볼륨 조절/햅틱
 * 피드백 3종의 실제 인터페이스가 이걸로 확정됐다. 문서에 나온 전송 메커니즘(bridge.js:
 * isIOS/isAOS 플랫폼 감지, iOS는 webkit.messageHandlers[fnName].postMessage, Android는
 * window.MtsBridge[fnName] 직접 호출 + registerCallback 콜백 등록 패턴)을 그대로 옮겨왔다.
 *
 * 고객정보(requestCustomerInfo)·거래키 전달(notifyTransactionKey)·가입 완료(notifyCompletion)·웹뷰 종료(close)는
 * 이 문서 범위 밖이라 같은 방식으로 코이웨어가 제안한 이름이다(2026-10-13) - 한투 확정(요구사항 확인 필요 사항
 * 9·30번) 후 이름이 다르면 이 파일의 해당 함수만 교체하면 된다.
 *
 * 브릿지가 없는 환경(일반 브라우저로 직접 열어서 테스트할 때 등)에서는 모든 함수가 안전하게
 * "브릿지 없음"으로 동작한다 - 로컬/데모 테스트가 계속 가능하도록 하기 위함이다.
 */

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isAOS = () => /Android/.test(navigator.userAgent);
const MTS_BRIDGE_NAME = "MtsBridge";

/** 이벤트명(fnName)에 대응하는 네이티브 메시지 전송 함수를 플랫폼별로 찾아 반환한다. */
function getNativeMessageSender(fnName) {
  try {
    if (isIOS()) {
      const messageHandler = window.webkit?.messageHandlers?.[fnName];
      if (typeof messageHandler?.postMessage === "function") {
        return (payload) => messageHandler.postMessage(payload ?? "");
      }
    }
    if (isAOS()) {
      const bridge = window[MTS_BRIDGE_NAME];
      const bridgeFunction = bridge?.[fnName];
      if (typeof bridgeFunction === "function") {
        return (payload) => {
          if (payload === null) {
            bridgeFunction.call(bridge);
            return;
          }
          bridgeFunction.call(bridge, payload);
        };
      }
    }
  } catch (err) {
    console.error(`[nativeBridge] Error getting bridge for ${fnName}:`, err);
  }
  return undefined;
}

/** 문자열이 아닌 데이터는 JSON으로 직렬화해서 보낸다. 전송 성공 여부(브릿지 존재 여부)를 반환한다. */
function sendMessageToNative(eventName, data = null) {
  const messageSender = getNativeMessageSender(eventName);
  if (!messageSender) {
    console.warn(`[nativeBridge] Bridge not found for: ${eventName}`);
    return false;
  }
  let serializedData = typeof data === "string" ? data : JSON.stringify(data || "");
  if (data === null) serializedData = null;
  try {
    messageSender(serializedData);
    return true;
  } catch (err) {
    console.error(`[nativeBridge] Error sending bridge message for ${eventName}:`, err);
    return false;
  }
}

const callbacksRegistry = {};

/**
 * 네이티브가 window[eventName](payload)를 호출하면(가이드 문서 "메시지 수신" 참고), 등록된
 * 모든 콜백을 실행한다. payload가 JSON 문자열이면 파싱해서 넘긴다.
 * @returns {Function} 콜백 해제 함수
 */
function registerCallback(eventName, callback) {
  if (!callbacksRegistry[eventName]) {
    callbacksRegistry[eventName] = [];
    window[eventName] = function (...payload) {
      const data = payload.map((item) => {
        if (typeof item !== "string") return item;
        try {
          return JSON.parse(item);
        } catch {
          return item;
        }
      });
      (callbacksRegistry[eventName] || []).forEach((cb) => {
        try {
          cb(...data);
        } catch (e) {
          console.error(`[nativeBridge] Error in callback for ${eventName}:`, e);
        }
      });
    };
  }
  callbacksRegistry[eventName].push(callback);
  return function unregister() {
    const idx = callbacksRegistry[eventName].indexOf(callback);
    if (idx !== -1) callbacksRegistry[eventName].splice(idx, 1);
  };
}

/**
 * 요청-응답 하나를 "요청 이벤트 전송 → 응답 이벤트 1회 수신"으로 감싸는 헬퍼. 가이드 문서의
 * receiveSuccess/receiveFailed 예시와 달리, 실제 인터페이스 규격표는 기능별로 자기만의 응답
 * 이벤트명을 쓰므로(requestSystemAudioState -> receivedSystemAudioState) 이 형태가 맞다.
 * 브릿지가 없거나 응답이 안 오면(구형 앱, 브라우저 테스트 등) timeoutMs 후 fallback으로 resolve한다
 * - 이 요청들은 전부 "안 되면 그냥 기본값으로 진행"이 맞는 보조 기능이라, 실패를 reject해서 Player
 * 플로우를 막을 이유가 없다.
 */
function requestOnce(requestEvent, responseEvent, requestBody, fallback, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      unregister();
      clearTimeout(timer);
      resolve(value);
    };
    const unregister = registerCallback(responseEvent, (data) => finish(data));
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    if (!sendMessageToNative(requestEvent, requestBody)) {
      finish(fallback);
    }
  });
}

/** 고객정보 요청 응답 대기 시간 - 앱이 이 안에 답하지 않으면 값 없이 진행한다. */
const CUSTOMER_INFO_TIMEOUT_MS = 3000;
/** 완료 콜백 전달 재시도 - 브릿지 호출이 예외로 실패할 때만 의미가 있다(응답 확인이 없는 단방향 호출). */
const COMPLETION_NOTIFY_ATTEMPTS = 3;
const COMPLETION_NOTIFY_RETRY_MS = 500;

window.KoiNativeBridge = {
  /** 이 이벤트의 네이티브 브릿지가 있는지(앱 웹뷰 안인지) - 일반 브라우저 테스트와 구분하는 데 쓴다. */
  hasBridge(eventName) {
    return !!getNativeMessageSender(eventName);
  },

  /**
   * 한투앱으로부터 고객 전화번호·이름(+선택으로 상품코드)을 받아온다 - 가이드와 같은 방식으로 requestCustomerInfo 를
   * 보내고 receivedCustomerInfo 로 응답을 받는다(2026-10-13, 이전의 window.KoiwareApp 임시 방식 교체).
   * 앱이 3초 안에 응답하지 않거나 브릿지가 없으면(일반 브라우저) 값 없이 진행한다.
   * ⚠️ 이벤트명은 코이웨어 제안안(JS 브릿지 규격서) - 한투 확정 후 필요하면 교체한다.
   * @returns {Promise<{phoneNumber: string|null, name: string|null, productCode: string|null}>}
   */
  async requestCustomerInfo() {
    const empty = { phoneNumber: null, name: null, productCode: null };
    try {
      const data = await requestOnce("requestCustomerInfo", "receivedCustomerInfo", null, null, CUSTOMER_INFO_TIMEOUT_MS);
      if (data && typeof data === "object") {
        return {
          phoneNumber: data.phoneNumber || null,
          name: data.name || null,
          // 어떤 상품설명서를 받을지 - 앱이 넘겨주면 그대로 쓴다(URL ?productCode= 가 있으면 그쪽이 우선)
          productCode: data.productCode || null,
        };
      }
    } catch (err) {
      console.warn("[nativeBridge] 고객정보 요청 실패:", err);
    }
    console.log("[nativeBridge] 고객정보 미전달 - 브릿지가 없거나 응답이 없어 값 없이 진행합니다");
    return empty;
  },

  /**
   * Player 가 만든 거래키를 앱에 알려 준다(2026-10-13) - 앱이 전화번호·이름을 준 직후, 거래키를 만든 시점에 1회.
   * 같은 거래키를 가입 완료 때(notifyCompletion)도 다시 넘긴다. 앱이 이 값을 못 받아도 고객 플로우는 계속된다.
   * ⚠️ 이벤트명 notifyTransactionKey 는 코이웨어 제안안 - 한투 확정 대상.
   * @returns {boolean} 앱에 전달했으면 true (브릿지가 없거나 실패하면 false)
   */
  notifyTransactionKey(transactionKey) {
    try {
      return sendMessageToNative("notifyTransactionKey", { transactionKey });
    } catch (err) {
      console.warn("[nativeBridge] 거래키 전달 실패:", err);
      return false;
    }
  },

  /**
   * 간편가입 완료를 한투앱에 알린다. payload: {transactionKey, customerKey?} - customerKey 는 가입완료 검증 API 를
   * 쓰는 경우에만 의미가 있어 값이 있을 때만 싣는다. 앱 웹뷰 안에서 호출이 실패하면(브릿지 예외) 짧게 재시도한다.
   * ⚠️ 이벤트명 notifyCompletion 과 payload 는 코이웨어 제안안 - 한투 확정 대상.
   * @param {string} transactionKey
   * @param {string|null} customerKey
   * @returns {Promise<"sent"|"no-bridge"|"failed">} 앱에 전달함 / 브릿지 없음(일반 브라우저) / 재시도 후에도 실패
   */
  async notifyCompletion(transactionKey, customerKey) {
    if (!getNativeMessageSender("notifyCompletion")) {
      console.log("[nativeBridge] 브릿지 없음 - 완료 콜백 스킵 (일반 브라우저 테스트 중일 수 있음)");
      return "no-bridge";
    }
    const payload = customerKey ? { transactionKey, customerKey } : { transactionKey };
    for (let attempt = 1; attempt <= COMPLETION_NOTIFY_ATTEMPTS; attempt++) {
      try {
        if (sendMessageToNative("notifyCompletion", payload)) return "sent";
      } catch (err) {
        console.warn(`[nativeBridge] 완료 콜백 실패 (${attempt}/${COMPLETION_NOTIFY_ATTEMPTS}):`, err);
      }
      if (attempt < COMPLETION_NOTIFY_ATTEMPTS) await new Promise((r) => setTimeout(r, COMPLETION_NOTIFY_RETRY_MS));
    }
    return "failed";
  },

  /**
   * 웹뷰(화면)를 닫아 달라고 네이티브에 요청한다 - 카메라 권한 거부 등으로 더 진행할 수 없을 때 쓴다.
   * 웹에서 스스로 닫을 수는 없다(window.close()는 스크립트가 연 창만 닫을 수 있어 앱 웹뷰에선 동작하지 않는다).
   * ⚠️ 가이드 문서의 단방향 호출 예시(NativePlugins.close(), "웹뷰 종료")를 근거로 이벤트명을 "close"로
   * 추정했다 - 인터페이스 규격표에는 이름이 없어 한투 네이티브팀에 정확한 이벤트명 확인이 필요하다.
   * 브릿지가 없으면(일반 브라우저) window.close() → 이전 화면으로 이동 순으로 시도한다.
   * @returns {boolean} 네이티브에 요청을 보냈으면 true
   */
  closeWebView() {
    if (sendMessageToNative("close", null)) return true;
    try {
      window.close();
    } catch (err) {
      /* 닫을 수 없는 창이면 무시 */
    }
    if (history.length > 1) history.back();
    return false;
  },

  /**
   * 시스템(단말) 오디오 상태를 확인한다 - 무음모드/음소거 여부, 현재 볼륨(0.0~1.0).
   * 확인 필요 사항 23번(무음모드 상태에서 음성 안내 진행 방식)의 기술적 수단은 이걸로 확보됐지만,
   * "무음이면 어떻게 할지"(경고 노출/진행 차단 등)는 아직 정책 미확정이라 이 함수는 상태 조회만
   * 제공한다 - 실제 정책이 정해지면 호출부(sign_up_main.js)에서 이 값을 사용하면 된다.
   *
   * ⚠️ 응답 필드명 "isMutsed"는 가이드 문서에 기재된 그대로다(오타로 보이나, 실제 연동 전
   * 한투 네이티브팀과 정확한 철자 재확인 필요 - 문서 자체에도 같은 주석이 있음).
   * @returns {Promise<{isMuted: boolean, volume: number}|null>} 브릿지가 없거나 응답이 없으면 null.
   */
  async requestSystemAudioState() {
    const result = await requestOnce("requestSystemAudioState", "receivedSystemAudioState", null, null);
    if (!result) {
      console.log("[nativeBridge] 브릿지 없음 - 시스템 오디오 상태 확인 불가");
      return null;
    }
    return { isMuted: !!result.isMutsed, volume: typeof result.volume === "number" ? result.volume : null };
  },

  /**
   * 시스템 볼륨을 올린다/내린다 (요청-전용, 응답 없음). amount는 가이드 문서 규격대로 0.0~1.0 범위.
   * @param {number} amount
   * @returns {boolean} 요청 전송 성공 여부(브릿지 존재 여부) - 실제 볼륨 반영 여부는 알 수 없다.
   */
  increaseSystemVolume(amount) {
    return sendMessageToNative("increaseSystemVolume", amount);
  },

  /** @param {number} amount @returns {boolean} */
  decreaseSystemVolume(amount) {
    return sendMessageToNative("decreaseSystemVolume", amount);
  },

  /**
   * 햅틱(진동) 피드백을 요청한다 - 한투 네이티브 브릿지 스펙 확정(2026-09-30).
   * @param {"light"|"medium"|"heavy"} style
   * @param {number} duration 밀리초
   * @returns {boolean} 요청 전송 성공 여부(브릿지 존재 여부)
   */
  requestHapticFeedback(style = "medium", duration = 200) {
    return sendMessageToNative("requestHapticFeedback", { style, duration });
  },

  /**
   * 진동(진동) 피드백 - 기존 호출부(showFaceWarning 등)와의 호환을 위해 남겨둔 얇은 래퍼.
   * 네이티브 브릿지(iOS/Android 공통, 위 requestHapticFeedback)를 우선 쓰고, 브릿지가 없는
   * 환경(일반 브라우저 테스트 등)에서는 Android/Chrome이 지원하는 표준 Web Vibration API로
   * 폴백한다. iOS Safari는 이 표준 API 자체가 없어(Apple 정책) 브릿지가 없으면 조용히 아무 일도
   * 하지 않는다.
   * @param {string} eventName 어떤 상황에서 호출됐는지 (로그용, 예: "gazeWarning")
   */
  triggerHaptic(eventName) {
    try {
      if (this.requestHapticFeedback("medium", 200)) {
        return;
      }
    } catch (err) {
      console.warn("[nativeBridge] 네이티브 진동 브릿지 호출 실패:", err);
    }
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(200);
    } else {
      console.log(`[nativeBridge] 진동 브릿지/API 없음 - 스킵 (event=${eventName})`);
    }
  },
};
