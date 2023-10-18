import { Connection, Server } from "partykit/server";

export default class Playground implements Server {
  onMessage(
    message: string | ArrayBuffer,
    sender: Connection<unknown>
  ): void | Promise<void> {
    if (message === "PING") {
      sender.send("PONG");
    }
  }
}
