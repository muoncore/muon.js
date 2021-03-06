import {Message, MuonClient} from "./MuonClient";
import * as uuid from "uuid"
import log from "./log";
const bichannel = require('muon-core').channel();

export default class WsTransport {

  private channels: Map<string, TransportChannel> = new Map()

  constructor(readonly muon: MuonClient) {

  }

  openChannel(serviceName, protocolName) {
    let chan = new TransportChannel(this.muon, serviceName, protocolName, () => this.channels.delete(chan.channelId))
    this.channels.set(chan.channelId, chan)
    return chan.connect()
  }

  handleTransportMessage(message: Message) {

    switch (message.step) {
      case "dat":
        let channel = this.channels.get(message.correlationId)

        if (channel == null) {

          let inbound = this.muon.decode(message.data)

          let chan = this.muon.infrastructure().serverStacks.openChannel(inbound.protocol)

          channel = new TransportChannel(this.muon, "", inbound.protocol, () => this.channels.delete(chan.channelId))
          channel.attachToServerChannel(message, chan)

          this.channels.set(message.correlationId, channel)
        }

        channel.sendToChannel(message)
        break;
      case "shutdown":
        let chan = this.channels.get(message.correlationId)
        if (chan != null) {
          this.channels.delete(message.correlationId)
          chan.sendToChannel(message)
        }
        break
      default:
        log.info("Unknown message " + JSON.stringify(message))
    }
  }
}


class TransportChannel {

  private bichannel
  channelId = uuid.v1()

  constructor(readonly muon: MuonClient, readonly serviceName, readonly protocolName, readonly onclose) {}

  sendToChannel(message: Message) {
    let payload = this.muon.decode(message.data)
    this.bichannel.rightConnection().send(payload)
  }

  shutdown() {

    this.sendToGateway({
      correlationId: this.channelId,
      step: "shutdown",
      type: "transport",
      data: ""
    } as Message);

    this.onclose()
  }

  attachToServerChannel(message: Message, chan: any) {
    this.channelId = message.correlationId

    this.bichannel = {
      rightConnection: () => { return {
        send: (msg) => chan.send(msg)
      }}
    }

    chan.listen((msg) => {
      if (msg == "poison") {
        this.shutdown();
        return;
      }
      let message = {
        correlationId: this.channelId,
        step: "dat",
        type: "transport",
        data: this.muon.encode(msg)
      }
      this.sendToGateway(message)
    })
  }

  connect() {
    this.bichannel = bichannel.create("browser-transport-left");

    this.bichannel.rightConnection().listen((msg) => {
      if (msg == "poison") {
        this.shutdown();
        return;
      }
      let message = {
        correlationId: this.channelId,
        step: "dat",
        type: "transport",
        data: this.muon.encode(msg)
      }

      this.sendToGateway(message)

    })

    return this.bichannel.leftConnection();
  }

  private sendToGateway(msg: Message) {
    try {
      this.muon.send(msg)
    } catch (err) {
      log.err("[***** TRANSPORT *****] Error received");
      log.err(JSON.stringify(err))
    }
  }
}
