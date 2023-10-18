// src/EventSource.ts
var SingleEventSource = class {
  _listeners;
  constructor() {
    this._listeners = /* @__PURE__ */ new Set();
  }
  subscribe = (listener) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };
  notify = (event) => {
    this._listeners.forEach((listener) => listener(event));
  };
};

// src/client.ts
var authTimeout = 1e4;
var socketConnectTimeout = 1e4;
var heartbeatInterval = 3e3;
var connectionBackoff = [250, 500, 1e3, 5e3];
var authBackoff = [250, 500, 1e3, 5e3];
var maxConnTries = 7;
var maxAuthTries = 7;
var awaitPromise = (func, timeout) => {
  let clearTimer;
  return new Promise(async (resolve, reject) => {
    try {
      clearTimer = setTimeout(
        () => reject({ code: 99, msg: "Auth timeout" }),
        timeout
      );
      const data = await func;
      clearTimeout(clearTimer);
      resolve(data);
    } catch (error) {
      clearTimeout(clearTimer);
      reject(error);
    }
  });
};
function generateUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  let d = (/* @__PURE__ */ new Date()).getTime();
  let d2 = typeof performance !== "undefined" && performance.now && performance.now() * 1e3 || 0;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    let r = Math.random() * 16;
    if (d > 0) {
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
var StopRetry = class extends Error {
  constructor(msg) {
    super(msg);
  }
};
var Conn = class {
  constructor(options) {
    this.options = options;
    this.eventHub = {
      messages: new SingleEventSource()
    };
    if (!options.userId) {
      options.userId = generateUUID();
    }
  }
  status = "not_started";
  stateBlock = "initial";
  socket = null;
  connRetry = 0;
  authRetry = 0;
  eventHub;
  counter = 0;
  onSocketError = (event) => {
    console.log(`[Socket internal error]`, event);
  };
  onSocketClose = (event) => {
    console.log(`[Socket internal close]`, event);
    if (event.code === 4e3) {
      this.counter++;
      this.stateBlock = "failed";
    }
  };
  buildUrl({
    host: rawHost,
    room,
    userId,
    protocol,
    data,
    party
  }) {
    const host = rawHost.replace(/^(http|https|ws|wss):\/\//, "");
    let url = `${protocol || (host.startsWith("localhost:") || host.startsWith("127.0.0.1:") ? "ws" : "wss")}://${host}/${party ? `parties/${party}` : "party"}/${room}`;
    if (data) {
      url += `?${new URLSearchParams({ ...data, userId }).toString()}`;
    } else {
      url += `?_pk=${userId}`;
    }
    console.log(`[Connection Url] ${url}`);
    return url;
  }
  //block
  async authentication() {
    this.stateBlock = "auth";
    const localCounter = this.counter;
    console.log(`[Authenticating...]`);
    if (typeof this.options.auth === "function") {
      try {
        const params = await awaitPromise(this.options.auth(), authTimeout);
        if (this.counter !== localCounter) {
          console.log(`[auth ok] but timers don't match, marked as stale`);
          return;
        }
        console.log(`[auth ok] moving to -> connection block`);
        this.connection(localCounter, params);
      } catch (error) {
        if (this.counter !== localCounter) {
          console.log(`[auth failed] but timers don't match, marked as stale`);
          return;
        }
        console.log(`[auth failed]  moving to -> error block`);
        this.authError(localCounter, error);
      }
    }
  }
  //cell
  async authError(counter, error) {
    this.stateBlock = "authError";
    if (error instanceof StopRetry) {
      console.log(`[Auth Fail] Server said stop retry`);
      return;
    }
    if (this.authRetry >= maxAuthTries) {
      console.log(`[Max Auth Tries] moving to -> Authentication Failed`);
      return;
    }
    setTimeout(() => {
      if (counter !== this.counter) {
        console.log(`[stale] [Switch -> Auth Block]`);
        return;
      }
      console.log(`[Switch -> Auth Block]`);
      this.authentication();
    }, authBackoff[this.authRetry] || 5e3);
    console.log(`[Schedule Reauth ${authBackoff[this.authRetry] || 5e3}ms]`);
    this.authRetry++;
  }
  //block
  async connection(counter, params) {
    this.stateBlock = "connection";
    this.authRetry = 0;
    try {
      let conn = await this._connectSocket(
        this.buildUrl({
          host: params?.host || this.options.host,
          room: params?.room || this.options.room,
          userId: this.options.userId,
          party: this.options.party,
          data: params?.data
        })
      );
      if (counter !== this.counter) {
        console.log(`[stale] [Connection ok]`);
        conn.close();
        conn = null;
        return;
      }
      this.socket = conn;
      console.log(`[Connection ok] moving to -> connected block`);
      this.connected(counter, conn);
    } catch (error) {
      if (counter !== this.counter) {
        console.log(`[stale] [Connection fail]`);
        return;
      }
      console.log(`[Connection fail] moving to -> connection error block`);
      this.connectionError(counter, error);
    }
  }
  //helper
  async _connectSocket(url) {
    if (this.options.waitForRoom && typeof this.options.connectionResolver !== "function")
      throw new Error(
        "Bad Config, no connectionResolver provided when waitForRoom was to true"
      );
    let con2 = null;
    let messageListenerRef;
    let connectionResolverRef;
    let cleanupRejectRef;
    const connectedSock = new Promise((resolve, reject) => {
      const conn = new WebSocket(url);
      con2 = conn;
      const messageListener = (e) => {
        this.eventHub.messages.notify(e);
      };
      messageListenerRef = messageListener;
      const connectionResolver2 = (e) => {
        if (typeof this.options.connectionResolver === "function") {
          this.options.connectionResolver(e, () => {
            conn.addEventListener("close", cleanupReject);
            conn.removeEventListener("error", cleanupReject);
            conn.removeEventListener("message", connectionResolver2);
            resolve(conn);
          });
        }
      };
      connectionResolverRef = connectionResolver2;
      const cleanupReject = (e) => {
        conn.removeEventListener("message", messageListener);
        reject(conn);
      };
      cleanupRejectRef = cleanupReject;
      conn.addEventListener("open", () => {
        if (!this.options.waitForRoom) {
          conn.removeEventListener("close", cleanupReject);
          conn.removeEventListener("error", cleanupReject);
          resolve(conn);
        }
      });
      conn.addEventListener("close", cleanupReject);
      conn.addEventListener("error", cleanupReject);
      if (this.options.waitForRoom && typeof this.options.connectionResolver === "function")
        conn.addEventListener("message", connectionResolver2);
      conn.addEventListener("message", messageListener);
      conn.addEventListener("close", this.onSocketClose);
      conn.addEventListener("error", this.onSocketError);
    });
    try {
      const con3 = await awaitPromise(
        connectedSock,
        socketConnectTimeout
      );
      return con3;
    } catch (error) {
      if (con2) {
        con2?.removeEventListener("close", cleanupRejectRef);
        con2?.removeEventListener("error", cleanupRejectRef);
        con2?.removeEventListener(
          "message",
          connectionResolverRef
        );
        con2?.removeEventListener("message", messageListenerRef);
        con2?.close();
      }
      throw error;
    }
  }
  //cell
  connectionError(counter, error) {
    this.stateBlock = "connectionError";
    if (error instanceof StopRetry) {
      console.log(`[Stop Retry] Connection Failed`);
      return;
    }
    if (this.connRetry >= maxConnTries) {
      console.log(`[Max Conn Tries] moving to -> Connection Failed`);
      return;
    }
    setTimeout(() => {
      if (counter !== this.counter) {
        console.log(`[stale] [Switch -> Auth Block]`);
        return;
      }
      console.log(`[Switch -> Auth Block]`);
      this.authentication();
    }, connectionBackoff[this.connRetry] || 5e3);
    console.log(
      `[Schedule Reconnect ${connectionBackoff[this.connRetry] || 5e3}ms]`
    );
    this.connRetry++;
  }
  //cell
  async connected(counter, conn) {
    this.stateBlock = "connected";
    this.connRetry = 0;
    const interval = setInterval(() => {
      if (counter !== this.counter) {
        console.log(`[stale] [CONNECTED PING]`);
        clearInterval(interval);
        return;
      }
      console.log(`[CONNECTED PING]`);
      conn.send("PING");
      const timeout = setTimeout(() => {
        if (counter !== this.counter) {
          console.log(`[stale] [PONG TIMEOUT]`);
          clearInterval(interval);
          return;
        }
        console.log(`[PONG TIMEOUT] moving to -> authentication block`);
        clearInterval(interval);
        this.removeConnection(conn);
        this.authentication();
      }, 2e3);
      const unsub = this.eventHub.messages.subscribe((e) => {
        if (e.data === "PONG") {
          console.log(`[CONNECTED PONG]`);
          clearTimeout(timeout);
          unsub();
        }
      });
    }, heartbeatInterval);
  }
  //cell
  async ping(counter, conn) {
  }
  //helper
  removeConnection(socket) {
    if (socket) {
      socket.removeEventListener("close", this.onSocketClose);
      socket.removeEventListener("error", this.onSocketError);
      socket.close();
    }
  }
  //this closes the socket, always called before reauth
  closeSocket() {
    if (this.socket) {
      console.log(`[Con closed]`);
      this.socket.removeEventListener("close", this.onSocketClose);
      this.socket.removeEventListener("error", this.onSocketError);
      this.socket.close();
      this.socket = null;
    }
  }
  start() {
    if (this.status === "stared") {
      console.warn(`Conn has already started`);
      return;
    }
    this.status = "stared";
    this.authentication();
  }
  //only stop if you want to stop the conn
  //reconn won't happen after this
  stop() {
    if (this.status === "stared") {
      this.status = "not_started";
      this.counter++;
      this.closeSocket();
    }
  }
  //so thinking of a case where we are manually guarding
  //let's say connection only updates properly, but during that period there is a reconnect
  //and now we're guarding on the stateBlock, it's all fine
  //but assuming that the block comes to the same status when the first socket is accepted
  //aauu shit we have 2 connections
  //so we need to have exit functions that make it stale in a manner
  //but how do exit functions know what to cleanup ?
  //the cleanup then should be how?
  //this is the only case that's a race condition, and can happen
  //we need to prepare for it, the only way to make it stale somehow
  //but maybe for now let's ignore that particular case
  //the problem is that it can happen to all listeners
  //* ok got a solution for the above, i.e. having counters, everytime an event like that happens the counter is updated,
  //* we only look at the counter locally if it still matches then we win else we lose and do a cleanup
  //* rethink the scenario for simple explaination
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* reconnect happens [counter 1]
  //* goes back to authenticating [counter 1]
  //* auth resolves [counter 0] counters don;t match oops stale event, do a cleanup/exit/ignore
  //* rethink the scenario 2
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* authError [counter 0], a timeout is set to move to auth
  //* reconnect happens [counter 1]
  //* goes back to authenticating [counter 1]
  //* timeout executes [counter 0] oops counters don't match, do a cleanup
  //* ok the below scenario obv tells us to use the counter during auth only
  //* and pass the counter between calls, not very cool, but can be refactored
  //* shit scenario
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* reconnect happens [counter 1]
  //* authError [counter 1], a timeout is set to move to auth
  //* goes back to authenticating [counter 1]
  //* connection [counter 1] //conn from reconnect
  //* connection [counter 1] //conn from authError timeout
  //* rethink the scenario 3
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* authError [counter 0], a timeout is set to move to auth
  //* timeout executes [counter 0] back to authentication
  //* reconnect happens but same state, so it's ignored || //* reconnect happens but same state, so redo with counter
  //* rethink the scenario 4
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* connection [counter 0]
  //* reconnect happens [counter 1]
  //* connection success [counter 0] but oops counter don't match, so fail & cleanup
  //* So the cases where we're in the correct place, ex
  //* connRetry moves back to auth
  //* reconnect happens
  //* since it's the same place, we leave it be? or do we redo it again? both are possible with the current setup it'll just work
  //* now a case where we're happily connected
  //* reconnect happens
  //* umm, hmm... we exited the connection, so based on our state we nead to run exitConnection cleanup funciton ithink
  //so we basically need these as gatekeepers as well for state transitiong, and the internal machine only should be responsible for the transition
  //and these will talk to the machine?
  //let's say conn is timedout & rejected, but later the conn actually get connected it may cause a race condition
  async idle() {
  }
  async enterAuth() {
  }
  //authentication
  //authError
  async exitAuth() {
  }
  async enterConnection() {
  }
  //connection
  //connectionError
  async exitConnection() {
  }
  enterConnected() {
  }
  //connected
  //connectedError
  async exitConnected() {
    console.log(`[Exit Conn]`);
    this.socket?.close();
  }
  //userland events should increase the counter
  async reconnect() {
    if (this.status !== "stared") {
      console.warn(`Cannot reconnect machine is not started`);
      return;
    }
    if (this.stateBlock === "connected") {
      this.exitConnected();
    }
    this.counter++;
    this.authentication();
  }
  async close() {
    if (this.status !== "stared") {
      console.warn(`Cannot reconnect machine is not started`);
      return;
    }
    if (this.stateBlock === "connected") {
      this.exitConnected();
    }
    this.counter++;
  }
};
var happyAuthPromise = (timeout = 2e3) => {
  return new Promise((res, rej) => {
    setTimeout(() => {
      res({
        url: `ws://localhost:1999/party/b?_pk=78${Math.random().toString()}9ae98c${Math.random().toString()}-2f8b-4a5d-9c11${(Math.random() * Math.random()).toString()}-74df958f5655`
      });
    }, timeout);
  });
};
var con = new Conn({
  host: "localhost:1999",
  room: "bb",
  auth: happyAuthPromise,
  waitForRoom: false,
  //use to wait for a prticular message, waitForRoom should be true
  connectionResolver: function connectionResolver(e, resolver) {
    if (typeof e.data === "string") {
      try {
        const data = JSON.parse(e.data);
        if (data && data._pwf === "-1" && data.event === 4) {
          console.log(data);
          resolver();
        }
      } catch (error) {
      }
    }
  }
});
con.start();
var buttonElement = document.createElement("button");
buttonElement.textContent = "Reconnect";
document.body.appendChild(buttonElement);
function buttonClickHandler(event) {
  con.reconnect();
}
buttonElement.addEventListener("click", buttonClickHandler);
var cc = document.createElement("button");
cc.textContent = "Stop";
document.body.appendChild(cc);
function ccWa(event) {
  con.stop();
}
cc.addEventListener("click", ccWa);
var dd = document.createElement("button");
dd.textContent = "Close";
document.body.appendChild(dd);
function ddWa(event) {
  con.close();
}
dd.addEventListener("click", ddWa);
export {
  Conn
};
//# sourceMappingURL=client.js.map
