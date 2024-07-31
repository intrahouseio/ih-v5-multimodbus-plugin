const util = require('util');
const tools = require('./tools');
const Modbus = require('modbus-serial');

const networkErrors = ['ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH'];
const sleep = ms => new Promise(resolve => nextTimer = setTimeout(resolve, ms));

module.exports = {
  clients: {},
  params: {},
  channels: [],
  channelsChstatus: {},
  channelsData: {},
  qToRead: [],

  async start(plugin) {
    this.plugin = plugin;
    this.params = plugin.params;
    this.plugin.onAct(this.parseAct.bind(this));
    this.plugin.onCommand(async data => this.parseCommand(data));

    this.plugin.channels.onChange(() => this.updateChannels(true));

    process.on('exit', this.terminatePlugin.bind(this));
    process.on('SIGTERM', () => {
      this.terminatePlugin.bind(this);
      process.exit(0);
    });

    try {
      await this.updateChannels(false);

      await this.connect();
      this.setWorking();

      await this.sendNext();
    } catch (err) {
      this.checkError(err);
    }
  },

  setWorking() {
    // Если запускается со старой версией сервера - функции может не быть
    try {
      this.plugin.sendWorkingState();
    } catch (e) {
      this.plugin.log('Failed "plugin.sendWorkingState". System update required.', 1);
    }
  },

  terminatePlugin() {
    Object.keys(this.clients).forEach(item => {
      this.clients[item].close();
    })
  },

  parseAct(message) {
    try {
      message.data.forEach(aitem => {
        const item = this.formWriteObject(aitem);
        if (item) {
          this.qToWrite.push(item);
          this.plugin.log(`Command to write: ${util.inspect(this.qToWrite)}`, 2);
        }
      });
    } catch (err) {
      this.checkError(err);
    }
  },

  formWriteObject(chanItem) {
    if (!chanItem) return;
    this.plugin.log("chanItem: " + util.inspect(chanItem), 1);
    // Копировать свойства канала в объект
    const res = {
      id: chanItem.id,
      nodeip: chanItem.nodeip,
      nodeport: chanItem.nodeport,
      nodetransport: chanItem.nodetransport,
      unitid: chanItem.unitid,
      value: Number(chanItem.value) || 0,
      command: chanItem.value || 'set',
      manbo: chanItem.manbo
    };

    if (chanItem.manbo) {
      res.manbo8 = chanItem.manbo8;
      res.manbo16 = chanItem.manbo16;
      res.manbo32 = chanItem.manbo32;
      res.manbo64 = chanItem.manbo64;
    }

    if (chanItem.diffw || (!chanItem.r && chanItem.wvartype && chanItem.wvartype)) {
      res.address = parseInt(chanItem.waddress);
      res.vartype = chanItem.wvartype;
      res.fcw = parseInt(chanItem.fcw);
      res.force = 0;
    } else {
      res.address = parseInt(chanItem.address);
      res.vartype = chanItem.vartype;
      res.fcw = parseInt(chanItem.fcw);
      res.force = chanItem.r ? 1 : 0;
    }
    if (chanItem.parentoffset) res.address += parseInt(chanItem.parentoffset);

    if (!res.vartype) {
      this.plugin.log('ERROR: Command has empty vartype: ' + util.inspect(chanItem), 1);
      return;
    }
    res.vartype = res.manbo ? this.getVartypeMan(res) : this.getVartype(res.vartype);

    if (chanItem.usek) {
      res.usek = 1;
      res.ks0 = parseInt(chanItem.ks0);
      res.ks = parseInt(chanItem.ks);
      res.kh0 = parseInt(chanItem.kh0);
      res.kh = parseInt(chanItem.kh);
    }

    if (chanItem.bit) {
      res.bit = chanItem.bit;
      res.offset = parseInt(chanItem.offset);
      res.fcr = parseInt(chanItem.fcr);
      res.title = chanItem.chan;
    }

    return res;
  },

  async parseCommand(message) {
    this.plugin.log(`Command '${message.command}' received. Data: ${util.inspect(message)}`, 1);
    let payload = [];

    try {
      switch (message.command) {
        case 'read':
          if (message.data !== undefined) {
            for (const item of message.data) {
              payload.push(Object.assign({ value: await this.readValueCommand(item) }, item));
            }
            // payload = message.data.map(item => Object.assign({ value: this.readValueCommand(item) }, item));
          }
          this.plugin.sendResponse(Object.assign({ payload }, message), 1);
          break;

        case 'write':
          if (message.data !== undefined) {
            for (const item of message.data) {
              payload.push(await this.writeValueCommand(item));
            }
            // payload = message.data.map(item => this.writeValueCommand(item));
          }

          this.plugin.sendResponse(Object.assign({ payload }, message), 1);
          break;

        case 'readOnReq':
          if (message.data != undefined) {
            message.data.forEach(item => {
              item.vartype = item.manbo ? this.getVartypeMan(item) : this.getVartype(item.vartype);
            })
            this.setRead(message);
          }
          break;

        default:
          break;
      }
    } catch (err) {
      this.plugin.sendResponse(Object.assign({ payload: message }, message), 0);
      this.checkError(err);
    }
  },

  async updateChannels(getChannels) {
    if (this.queue !== undefined) {
      await this.sendNext(true);
    }

    if (getChannels === true) {
      this.plugin.log('Request updated channels', 1);
      this.channels = await this.plugin.channels.get();
      //this.terminatePlugin();
    }

    if (this.channels.length === 0) {
      this.plugin.log(`Channels do not exist!`, 1);
      this.terminatePlugin();
      process.exit(8);
    }

    this.channels.forEach(item => {
      item.nodeport = parseInt(item.nodeport);
      item.unitid = parseInt(item.unitid);
      item.address = parseInt(item.address);
      if (item.parentoffset) item.address += parseInt(item.parentoffset);
      item.vartype = item.manbo ? this.getVartypeMan(item) : this.getVartype(item.vartype);
    });

    this.polls = tools.getPolls(
      this.channels.filter(item => item.r),
      this.params
    );
    this.plugin.log(`Polls = ${util.inspect(this.polls, null, 4)}`, 2);

    this.queue = tools.getPollArray(this.polls); // Очередь опроса -на чтение
    this.qToWrite = []; // Очередь на запись - имеет более высокий приоритет
    this.sendTime = 0;
  },

  async connect(nodeid) {
    let clientArr = []
    if (nodeid == undefined) {
      this.clients = {};
      this.polls.forEach(item => {
        const nodeid = item.nodeip + ":" + item.nodeport;
        this.clients[nodeid] = new Modbus();
        this.clients[nodeid].setTimeout(this.params.timeout);
        this.clients[nodeid].nodeip = item.nodeip;
        this.clients[nodeid].nodeport = item.nodeport;
        this.clients[nodeid].nodetransport = item.nodetransport;
      })
      clientArr = Object.keys(this.clients);
    } else {
      clientArr.push(nodeid);
    }

    for (let i = 0; i < clientArr.length; i++) {
      const item = this.clients[clientArr[i]];
      const options = { port: item.nodeport };
      const host = item.nodeip;
      const transport = item.nodetransport;
      try {
        this.plugin.log("Connect to " + transport + " " + host + ":" + item.nodeport, 1);

        switch (transport) {
          case 'tcp':
            if (!item.isOpen) await item.connectTCP(host, options);

            break;
          case 'rtutcp':
            if (!item.isOpen) await item.connectTcpRTUBuffered(host, options);

            break;
          case 'rtuOverTcp':
            if (!item.isOpen) await item.connectTelnet(host, options);

            break;
          /*case 'udp':
            if (!item.isOpen) await item.connectUDP(host, options);
            await sleep(100);
            break;*/
          default:
            throw new Error(`Протокол ${this.params.transport} еще не имплементирован`);
        }

      } catch (err) {
        let charr = [];
        this.channels.forEach(chitem => {         
          if (chitem.nodeip == item.nodeip && chitem.nodeport == item.nodeport && !this.channelsChstatus[chitem.id]) {
            charr.push({ id: chitem.id, chstatus: 1, title: chitem.title })
            this.channelsChstatus[chitem.id] = 1;
          }
        })
        if (charr.length > 0) this.plugin.sendData(charr);
        this.checkError(err);
        this.plugin.log(`Connection fail!`, 1);
      }
    }
  },

  // Это пока не работает!!!
  async checkResponse() {
    if (Date.now() - this.sendTime > this.params.timeout) {
      if (this.waiting) {
        let adr = Number(this.waiting.substr(0, 2));
        this.plugin.sendData(tools.deviceError(adr, 'Timeout error! No response'));
        this.waiting = '';
      }

      await this.sendNext();
    }
  },

  setRead(message) {
    this.qToRead = tools.getRequests(message.data, this.params);
    this.message = { unit: message.unit, param: message.param, sender: message.sender, type: message.type, uuid: message.uuid };

  },

  async read(item, allowSendNext) {
    const nodeid = item.nodeip + ":" + item.nodeport;
    this.clients[nodeid].setID(item.unitid);
    this.plugin.log(
      `READ: nodeId = ${item.nodetransport}:${nodeid}, unitId = ${item.unitid}, FC = ${item.fcr}, address = ${this.showAddress(item.address)}, length = ${item.length
      }`,
      1
    );

    try {
      let res = await this.modbusReadCommand(nodeid, item.fcr, item.address, item.length, item.ref);
      if (res && res.buffer) {
        const data = tools.getDataFromResponse(res.buffer, item.ref);
        if (this.params.sendChanges == 1) {          
          let arr = data.filter(item => {
            if (this.channelsData[item.id] != item.value ||  this.channelsChstatus[item.id] == 1) {
              this.channelsChstatus[item.id] = item.chstatus;
              this.channelsData[item.id] = item.value;
              return true;
            }
          });
          if (arr.length > 0) this.plugin.sendData(arr);
        } else {
          data.forEach(el => {
            this.channelsChstatus[el.id] = el.chstatus;
          });
          this.plugin.sendData(data);
        }

        // this.plugin.log(res.buffer, 2);
      }
    } catch (err) {
      this.checkError(err);
    }

    if (this.qToWrite.length || allowSendNext) {
      if (!this.qToWrite.length) {
        await sleep(this.params.polldelay || 1); // Интервал между запросами
      }
      setImmediate(() => {
        this.sendNext();
      });
    }
  },

  async readValueCommand(item) {
    const nodeid = item.nodeip + ":" + item.nodeport;
    this.clients[nodeid].setID(item.unitid);
    this.plugin.log(
      `READ: nodeId = ${item.nodetransport}:${nodeid}, unitId = ${item.unitid}, FC = ${item.fcr}, address = ${this.showAddress(item.address)}, length = ${item.length
      }`,
      1
    );

    try {
      let res = await this.modbusReadCommand(nodeid, item.fcr, item.address, item.length, item.ref);

      return tools.parseBufferRead(res.buffer, {
        widx: item.offset,
        vartype: item.vartype
      });
    } catch (err) {
      this.checkError(err);
    }
  },

  async modbusReadCommand(nodeid, fcr, address, length, ref) {
    if (!this.clients[nodeid].isOpen) {
      await this.connect(nodeid);
      if (!this.clients[nodeid].isOpen) throw new Error("Connection fail throw");
    }
    try {
      fcr = Number(fcr);
      switch (fcr) {
        case 2:
          return await this.clients[nodeid].readDiscreteInputs(address, length);
        case 1:
          return await this.clients[nodeid].readCoils(address, length);
        case 4:
          return await this.clients[nodeid].readInputRegisters(address, length);
        case 3:
          return await this.clients[nodeid].readHoldingRegisters(address, length);
        default:
          throw new Error(`Функция ${fcr} на чтение не поддерживается`);
      }
    } catch (err) {
      let charr = [];
      ref.forEach(item => {
        if (!this.channelsChstatus[item.id]) {
          this.channelsChstatus[item.id] = 1;
          charr.push({ id: item.id, chstatus: 1, title: item.title })
        }  
      });
      /*charr.forEach(el => {
        this.channelsChstatus[el.id] = 1;
      });*/
      if (charr.length) this.plugin.sendData(charr);      
      this.checkError(err);
    }
  },

  async readRequest(item, allowSendNext) {
    const nodeid = item.nodeip + ":" + item.nodeport;
    try {
      const res = await this.modbusReadCommand(nodeid, item.fcr, item.address, item.length, item.ref);
      if (res && res.buffer) {

        const data = tools.getDataFromResponse(res.buffer, item.ref);
        this.plugin.sendData(data);
      }
    } catch (error) {
      this.message.result = "Read Request Fail";
      this.plugin.sendResponse(this.message, 1);
      this.checkError(error);
    }

    if (this.qToRead.length == 0) {
      this.message.result = "Read Request Ok";
      this.plugin.sendResponse(this.message, 1);
    }


    if (this.qToRead.length || allowSendNext) {
      if (!this.qToRead.length) {
        await sleep(this.params.polldelay || 10); // Интервал между запросами
      }

      setImmediate(() => {
        this.sendNext();
      });
    }
  },

  async write(item, allowSendNext) {
    const nodeid = item.nodeip + ":" + item.nodeport;

    this.clients[nodeid].setID(parseInt(item.unitid));
    let fcw;
    //let fcw = item.vartype == 'bool' ? 5 : 6;
    this.plugin.log("WRITE FCW: " + item.fcw, 1);
    if (item.fcw) {
      fcw = item.fcw;
    } else {
      fcw = item.vartype == 'bool' ? 5 : 6;
    }
    let val = item.value;
    if (fcw == 6 || fcw == 16) {
      val = tools.writeValue(item.value, item);
      if (Buffer.isBuffer(val) && val.length > 2) fcw = 16;
    }

    if (item.bit) {
      item.ref = [];
      let refobj = tools.getRefobj(item);
      refobj.widx = item.address;
      item.ref.push(refobj);
      const res = await this.modbusReadCommand(nodeid, item.fcr, item.address, tools.getVarLen(item.vartype), item.ref);
      val = res.buffer;
      if (item.offset < 8) {
        val[1] = item.value == 1 ? val[1] | (1 << item.offset) : val[1] & ~(1 << item.offset);
      } else {
        val[0] = item.value == 1 ? val[0] | (1 << (item.offset - 8)) : val[0] & ~(1 << (item.offset - 8));
      }
    }

    this.plugin.log(
      `WRITE: nodeId = ${item.nodetransport}:${nodeid}, unitId = ${item.unitid}, FC = ${fcw}, address = ${this.showAddress(item.address)}, value = ${util.inspect(
        val
      )}`,
      1
    );

    // Результат на запись - принять!!
    try {
      let res = await this.modbusWriteCommand(nodeid, fcw, item.address, val);

      // Получили ответ при записи
      this.plugin.log(`Write result: ${util.inspect(res)}`, 1);

      if (item.force) {
        // Только если адрес для чтения и записи одинаковый
        // Отправить значение этого канала как при чтении
        this.plugin.sendData([{ id: item.id, value: item.value }]);
      }
    } catch (err) {
      this.checkError(err);
    }

    if (this.qToWrite.length || allowSendNext) {
      if (!this.qToWrite.length) {
        await sleep(this.params.polldelay || 1); // Интервал между запросами
      }
      setImmediate(() => {
        this.sendNext();
      });
    }
  },

  async writeValueCommand(item) {
    const nodeid = item.nodeip + ":" + item.nodeport;
    this.clients[nodeid].setID(item.unitid);
    let fcw;
    //let fcw = item.vartype == 'bool' ? 5 : 6;
    this.plugin.log("WRITE FCW: " + item.fcw, 2);
    if (item.fcw) {
      fcw = item.fcw;
    } else {
      fcw = item.vartype == 'bool' ? 5 : 6;
    }

    let val = item.value;
    if (fcw == 6 || fcw == 16) {
      val = tools.writeValue(item.value, item);
      if (Buffer.isBuffer(val) && val.length > 2) fcw = 16;
    }

    if (item.bit) {
      item.ref = [];
      let refobj = tools.getRefobj(item);
      refobj.widx = item.address;
      item.ref.push(refobj);
      const res = await this.modbusReadCommand(nodeid, item.fcr, item.address, tools.getVarLen(item.vartype), item.ref);
      val = res.buffer;
      if (item.offset < 8) {
        val[1] = item.value == 1 ? val[1] | (1 << item.offset) : val[1] & ~(1 << item.offset);
      } else {
        val[0] = item.value == 1 ? val[0] | (1 << (item.offset - 8)) : val[0] & ~(1 << (item.offset - 8));
      }
    }

    this.plugin.log(
      `WRITE: nodeId = ${item.nodetransport}:${nodeid}, unitId = ${item.unitid}, FC = ${fcw}, address = ${this.showAddress(item.address)}, value = ${util.inspect(
        val
      )}`,
      1
    );

    try {
      // let val = tools.writeValue(item.value, item);

      let res = await this.modbusWriteCommand(fcw, item.address, val);
      this.plugin.log(`Write result: ${util.inspect(res)}`, 1);
      if (item.force) {
        this.plugin.sendData([{ id: item.id, value: item.value }]);
      }

      return res;
    } catch (err) {
      this.checkError(err);
    }
  },

  async modbusWriteCommand(nodeid, fcw, address, value) {
    if (!this.clients[nodeid].isOpen) {
      await this.connect(nodeid);
      if (!this.clients[nodeid].isOpen) throw new Error("Connection fail throw");
    }
    try {
      switch (fcw) {
        case 5:
          this.plugin.log(`writeCoil: address = ${this.showAddress(address)}, value = ${value}`, 1);
          return await this.clients[nodeid].writeCoil(address, value);

        case 6:
          this.plugin.log(
            `writeSingleRegister: address = ${this.showAddress(address)}, value = ${util.inspect(value)}`,
            1
          );
          return await this.clients[nodeid].writeRegister(address, value);

        case 15:
          this.plugin.log(`writeCoil: address = ${this.showAddress(address)}, value = ${value}`, 1);
          return await this.clients[nodeid].writeCoils(address, [value]);

        case 16:
          this.plugin.log(
            `writeMultipleRegisters: address = ${this.showAddress(address)}, value = ${util.inspect(value)}`,
            1
          );
          return await this.clients[nodeid].writeRegisters(address, value);

        default:
          throw new Error(`Функция ${fcw} на запись не поддерживается`);
      }
    } catch (err) {
      this.checkError(err);
    }
  },

  async sendNext(single) {
    // if (this.params.transport != 'tcp' && !this.client.isOpen) {
    /* if (!this.client.isOpen) {
       this.plugin.log('Port is not open! TRY RECONNECT');
       await this.connect();
     }*/

    let isOnce = false;
    if (typeof single !== undefined && single === true) {
      isOnce = true;
    }

    let item;
    if (this.qToWrite.length) {
      item = this.qToWrite.shift();
      this.plugin.log(`sendNext: WRITE item = ${util.inspect(item)}`, 2);
      return this.write(item, !isOnce);
    }

    if (this.qToRead.length) {
      item = this.qToRead.shift();
      return this.readRequest(item, !isOnce);
    }

    if (this.queue.length <= 0) {
      this.polls.forEach(item => {
        if (item.curpoll < item.polltimefctr) {
          item.curpoll++;
        } else {
          item.curpoll = 1;
        }
      })
      this.queue = tools.getPollArray(this.polls);
    }
    //this.plugin.log(`Queue = ${util.inspect(this.queue)}`, 2);
    item = this.queue.shift();
    if (typeof item !== 'object') {
      item = this.polls[item];

    }
    //this.plugin.log(`sendNext item = ${util.inspect(item)}`, 2);
    if (item) {
      return this.read(item, !isOnce);
    } else {
      await sleep(this.params.polldelay || 1);
      setImmediate(() => {
        this.sendNext();
      });
    }

  },

  checkError(e) {
    if (e.errno && networkErrors.includes(e.errno)) {
      this.plugin.log('Network ERROR: ' + e.errno, 1);
      //this.terminatePlugin();
      //process.exit(1);
    } else {
      this.plugin.log('ERROR: ' + util.inspect(e), 1);
    }
    // Если все каналы c chstatus=1 - перезагрузить плагин
    for (const item of this.channels) {
      if (!this.channelsChstatus[item.id]) return;
    }
    this.plugin.log('All channels have bad status! Exit with code 42', 1);
    exitCode = 42;
    this.terminatePlugin();
    process.exit(exitCode);
    // TODO - проверить ошибку и не всегда выходить
    /*if (this.params.transport == 'tcp') {
      this.terminatePlugin();
      process.exit(1);
    }*/
  },

  getVartype(vt) {
    let bits = vt.substr(-2, 2);

    if (vt === 'int8' || vt === 'uint8') {
      return vt + this.params.bo8;
    }

    if (bits === '16') {
      return vt + this.params.bo16;
    }

    if (bits === '32' || vt === 'float') {
      return vt + this.params.bo32;
    }

    if (bits === '64' || vt === 'double') {
      return vt + this.params.bo64;
    }

    return vt;
  },

  getVartypeMan(item) {
    let vt = item.vartype;
    let bits = vt.substr(-2, 2);

    if (vt === 'int8' || vt === 'uint8') {
      return vt + item.manbo8;
    }

    if (bits === '16') {
      return vt + item.manbo16;
    }

    if (bits === '32' || vt === 'float') {
      return vt + item.manbo32;
    }

    if (bits === '64' || vt === 'double') {
      return vt + item.manbo64;
    }

    return vt;
  },

  showAddress(address) {
    if (isNaN(address)) {
      return 'NaN';
    }
    return `${address} (0x${Number(address).toString(16)})`;
  }
};
