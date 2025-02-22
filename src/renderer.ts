/// <reference path="./global.d.ts" />

import {AtType, ChatType, Group, MessageElement, Peer, PostDataSendMsg, RawMessage, User} from "./common/types";


import {OB11SendMsgReturn} from "./onebot11/types";
import {ipcRenderer} from "electron";
import {CHANNEL_GET_HISTORY_MSG} from "./common/channels";

let groups: Group[] = []
let friends: User[] = []
let uid_maps: Record<string, User> = {}  // 一串加密的字符串 -> qq号

function getStrangerByUin(uin: string) {
    for (const key in uid_maps) {
        if (uid_maps[key].uin === uin) {
            return uid_maps[key];
        }
    }
}

async function getHistoryMsg(msgId: string) {
    return await window.llonebot.getHistoryMsg(msgId);
}

async function getUserInfo(uid: string): Promise<User> {
    let user = uid_maps[uid]
    if (!user) {
        // 从服务器获取用户信息
        user = await window.LLAPI.getUserInfo(uid)
        uid_maps[uid] = user
    }
    return user
}

async function getFriends() {
    let _friends = await window.LLAPI.getFriendsList(false)
    for (let friend of _friends) {
        let existFriend = friends.find(f => f.uin == friend.uin)
        if (!existFriend) {
            friends.push(friend)
        }
    }
    window.llonebot.updateFriends(friends)
    return friends
}

async function getFriend(qq: string) {
    let friend = friends.find(friend => friend.uin == qq)
    if (!friend) {
        await getFriends();
        friend = friends.find(friend => friend.uin == qq);
    }
    return friend;
}

async function getGroup(qq: string) {
    let group = groups.find(group => group.uid == qq)
    if (!group) {
        await getGroups();
        group = groups.find(group => group.uid == qq)
    }
    return group
}

async function getGroups() {
    let __groups = await window.LLAPI.getGroupsList(false)
    for (let group of __groups) {
        group.members = [];
        let existGroup = groups.find(g => g.uid == group.uid)
        if (!existGroup) {
            // console.log("更新群列表", groups)
            groups.push(group)
        }
    }
    window.llonebot.updateGroups(groups)
    return groups
}

async function getGroupMembers(group_qq: string, forced: boolean = false) {
    let group = await getGroup(group_qq)
    if (!group?.members || group!.members!.length == 0 || forced) {
        let res = (await window.LLAPI.getGroupMemberList(group_qq, 5000))
        // console.log(`更新群${group}成员列表 await`, _res)
        // window.LLAPI.getGroupMemberList(group_qq + "_groupMemberList_MainWindow", 5000).then(res =>{
        let members = res.result.infos.values();
        console.log("getGroupMemberList api response：", res)
        if (members && forced) {
            group.members = []
        }
        for (const member of members) {
            if (!group!.members!.find(m => m.uid == member.uid)) {
                group!.members!.push(member)
            }
            uid_maps[member.uid] = {
                uin: member.uin,
                uid: member.uid,
                nickName: member.nick
            };
        }
        window.llonebot.updateGroups(groups)
        console.log(`更新群${group.name}成员列表`, group)
        // })
    }
    return group?.members
}

async function getGroupMember(group_qq: string, member_uid: string) {
    let members = await getGroupMembers(group_qq)
    if (members) {
        let member = members.find(member => member.uid == member_uid)
        if (!member) {
            members = await getGroupMembers(group_qq, true)
            member = members?.find(member => member.uid == member_uid)
        }
        return member
    }
}


async function listenSendMessage(postData: PostDataSendMsg) {
    console.log("收到发送消息请求", postData);
    let sendMsgResult: OB11SendMsgReturn = {
        retcode: 0,
        status: 0,
        data: {
            message_id: ""
        },
        message: "发送成功"
    }
    if (postData.action == "send_private_msg" || postData.action == "send_group_msg") {
        let peer: Peer | null = null;
        if (!postData.params) {
            postData.params = {
                message: postData.message,
                user_id: postData.user_id,
                group_id: postData.group_id
            }
        }
        if (postData.action == "send_private_msg") {
            let friend = await getFriend(postData.params.user_id)
            if (friend) {
                console.log("好友消息", postData)
                peer = {
                    chatType: ChatType.friend,
                    name: friend.nickName,
                    uid: friend.uid
                }
            } else {
                // 临时消息
                console.log("发送临时消息", postData)
                let receiver = getStrangerByUin(postData.params.user_id);
                if (receiver) {
                    peer = {
                        chatType: ChatType.temp,
                        name: receiver.nickName,
                        uid: receiver.uid
                    }
                } else {
                    sendMsgResult.status = -1;
                    sendMsgResult.retcode = -1;
                    sendMsgResult.message = `发送失败，未找到对象${postData.params.user_id}，检查他是否为好友或是群友`;
                }
            }
        } else if (postData.action == "send_group_msg") {
            let group = await getGroup(postData.params.group_id)
            if (group) {
                peer = {
                    chatType: ChatType.group,
                    name: group.name,
                    uid: group.uid
                }
            } else {
                sendMsgResult.status = -1;
                sendMsgResult.retcode = -1;
                sendMsgResult.message = `发送失败，未找到群${postData.params.group_id}`;
                console.log("未找到群, 发送群消息失败", postData)
            }
        }
        if (peer) {
            let sendFiles: string[] = [];
            for (let message of postData.params.message) {
                if (message.type == "at") {
                    // @ts-ignore
                    message.type = "text"
                    message.atType = AtType.atUser
                    let atUid = message.data?.qq || message.atUid
                    if (atUid == "all") {
                        message.atType = AtType.atAll
                        atUid = "0";
                        message.content = `@全体成员`
                    } else {
                        let group = await getGroup(postData.params.group_id)
                        let atMember = group.members.find(member => member.uin == atUid)
                        message.atNtUid = atMember.uid
                        message.atUid = atUid
                        message.content = `@${atMember.cardName || atMember.nick}`
                    }
                } else if (message.type == "text") {
                    message.content = message.data?.text || message.content
                } else if (message.type == "image" || message.type == "voice" || message.type == "record") {
                    // 收到的是uri格式的，需要转成本地的, uri格式有三种，http, file, base64
                    let url = message.data?.file || message.file
                    let uri = new URL(url);
                    let ext: string;
                    if (message.type == "image") {
                        ext = ".png"
                    }
                    if (message.type == "voice" || message.type == "record") {
                        message.type = "voice"
                        ext = ".amr"
                    }
                    let localFilePath = `${Date.now()}${ext}`
                    if (uri.protocol == "file:") {
                        localFilePath = url.split("file://")[1]
                    } else {
                        const {errMsg, path} = await window.llonebot.downloadFile({
                            uri: url,
                            fileName: `${Date.now()}${ext}`
                        })
                        console.log("下载文件结果", errMsg, path)
                        if (errMsg) {
                            console.log("下载文件失败", errMsg);
                            sendMsgResult.status = -1;
                            sendMsgResult.retcode = -1;
                            sendMsgResult.message = `发送失败，下载文件失败，${errMsg}`;
                            break;
                        } else {
                            localFilePath = path;
                        }
                        sendFiles.push(localFilePath);
                    }
                    message.file = localFilePath
                } else if (message.type == "reply") {
                    let msgId = message.data?.id || message.msgId
                    const rawMsg: RawMessage = await getHistoryMsg(msgId)
                    if (rawMsg){
                        message.msgId = msgId
                        message.msgSeq = rawMsg.msgSeq
                    }
                }
            }
            console.log("发送消息", postData)
            if (sendMsgResult.status !== 0) {
                window.llonebot.sendSendMsgResult(postData.ipc_uuid, sendMsgResult)
                return;
            }
            window.LLAPI.sendMessage(peer, postData.params.message).then(
                (res: MessageElement) => {
                    console.log("消息发送成功:", res, peer, postData.params.message)
                    if (sendFiles.length) {
                        window.llonebot.deleteFile(sendFiles);
                    }
                    sendMsgResult.data.message_id = res.raw.msgId;
                    window.llonebot.sendSendMsgResult(postData.ipc_uuid, sendMsgResult)
                },
                err => {
                    sendMsgResult.status = -1;
                    sendMsgResult.retcode = -1;
                    sendMsgResult.message = `发送失败，${err}`;
                    window.llonebot.sendSendMsgResult(postData.ipc_uuid, sendMsgResult)
                    console.log("消息发送失败", postData, err)
                })
        } else {
            console.log(sendMsgResult, postData);
            window.llonebot.sendSendMsgResult(postData.ipc_uuid, sendMsgResult)
        }
    }
}

function recallMessage(msgId: string) {
    getHistoryMsg(msgId).then((msg: RawMessage)=>{
        const peer: Peer ={
            chatType: msg.chatType,
            name: "",
            uid: msg.peerUin
        }
        window.LLAPI.recallMessage(peer, [msgId]).then()
    })

}

let chatListEle: HTMLCollectionOf<Element>

async function getGroupsMembers(groupsArg: Group[]) {
    // 批量获取群成员列表
    let failedGroups: Group[] = []
    for (const group of groupsArg) {
        let handledGroup = await getGroupMembers(group.uid, true)
        if (handledGroup.length == 0) {
            failedGroups.push(group)
        }
    }
    if (failedGroups.length > 0) {
        console.log("获取群成员列表失败，重试", failedGroups.map(group => group.name))
        setTimeout(() => {
            getGroupsMembers(failedGroups).then()
        }, 1000)
    } else {
        window.llonebot.log("全部群成员获取完毕")
    }
}


async function initAccountInfo() {
    let accountInfo = await window.LLAPI.getAccountInfo();
    window.llonebot.log("getAccountInfo " + JSON.stringify(accountInfo));
    if (!accountInfo.uid) {
        return false;
    }
    let selfInfo = await window.LLAPI.getUserInfo(accountInfo.uid);
    window.llonebot.setSelfInfo({
        user_id: accountInfo.uin,
        nickname: selfInfo.nickName
    });
    window.llonebot.log("selfInfo " + JSON.stringify(selfInfo));
    return true;
}

function onLoad() {
    window.llonebot.log("llonebot render onLoad");
    window.llonebot.getRunningStatus().then(running => {
        if (running) {
            return;
        }
        initAccountInfo().then(
            (initSuccess) => {
                if (!initSuccess) {
                    return;
                }
                if (friends.length == 0) {
                    getFriends().then(() => {
                    });
                }
                if (groups.length == 0) {
                    getGroups().then(() => {
                        getGroupsMembers(groups).then(() => {
                        });
                    });
                }
                window.llonebot.log("llonebot render start");
                window.llonebot.startExpress();

                window.llonebot.listenSendMessage((postData: PostDataSendMsg) => {
                    listenSendMessage(postData).then().catch(err => console.log("listenSendMessage err", err))
                })
                window.llonebot.listenRecallMessage((arg: { message_id: string }) => {
                    // console.log("listenRecallMessage", arg)
                    recallMessage(arg.message_id)
                })
                window.llonebot.log("llonebot loaded");
                //     window.LLAPI.add_qmenu((qContextMenu: Node) => {
                //         let btn = document.createElement("a")
                //         btn.className = "q-context-menu-item q-context-menu-item--normal vue-component"
                //         btn.setAttribute("aria-disabled", "false")
                //         btn.setAttribute("role", "menuitem")
                //         btn.setAttribute("tabindex", "-1")
                //         btn.onclick = () => {
                //             // window.LLAPI.getPeer().then(peer => {
                //             //     // console.log("current peer", peer)
                //             //     if (peer && peer.chatType == "group") {
                //             //         getGroupMembers(peer.uid, true).then(()=> {
                //             //             console.log("获取群成员列表成功", groups);
                //             //             alert("获取群成员列表成功")
                //             //         })
                //             //     }
                //             // })
                //             async function func() {
                //                 for (const group of groups) {
                //                     await getGroupMembers(group.uid, true)
                //                 }
                //             }
                //
                //             func().then(() => {
                //                 console.log("获取群成员列表结果", groups);
                //                 // 找到members数量为空的群
                //                 groups.map(group => {
                //                     if (group.members.length == 0) {
                //                         console.log(`${group.name}群成员为空`)
                //                     }
                //                 })
                //                 window.llonebot.updateGroups(groups)
                //             })
                //         }
                //         btn.innerText = "获取群成员列表"
                //         console.log(qContextMenu)
                //         // qContextMenu.appendChild(btn)
                //     })
                //
                //     window.LLAPI.on("context-msg-menu", (event, target, msgIds) => {
                //         console.log("msg menu", event, target, msgIds);
                //     })
                //
                //     // console.log("getAccountInfo", LLAPI.getAccountInfo());
                //     function getChatListEle() {
                //         chatListEle = document.getElementsByClassName("viewport-list__inner")
                //         console.log("chatListEle", chatListEle)
                //         if (chatListEle.length == 0) {
                //             setTimeout(getChatListEle, 500)
                //         } else {
                //             try {
                //                 // 选择要观察的目标节点
                //                 const targetNode = chatListEle[0];
                //
                //                 // 创建一个观察器实例并传入回调函数
                //                 const observer = new MutationObserver(function (mutations) {
                //                     mutations.forEach(function (mutation) {
                //                         // console.log("chat list changed", mutation.type); // 输出 mutation 的类型
                //                         // 获得当前聊天窗口
                //                         window.LLAPI.getPeer().then(peer => {
                //                             // console.log("current peer", peer)
                //                             if (peer && peer.chatType == "group") {
                //                                 getGroupMembers(peer.uid, false).then()
                //                             }
                //                         })
                //                     });
                //                 });
                //
                //                 // 配置观察选项
                //                 const config = {attributes: true, childList: true, subtree: true};
                //
                //                 // 传入目标节点和观察选项
                //                 observer.observe(targetNode, config);
                //
                //             } catch (e) {
                //                 window.llonebot.log(e)
                //             }
                //         }
                //     }
                //
                //     // getChatListEle();
            }
        );
    });
}

// 打开设置界面时触发
async function onSettingWindowCreated(view: Element) {
    window.llonebot.log("setting window created");
    let config = await window.llonebot.getConfig()

    function creatHostEleStr(host: string) {
        let eleStr = `
            <setting-item data-direction="row" class="hostItem vertical-list-item">
                <h2>事件上报地址(http)</h2>
                <input class="host input-text" type="text" value="${host}" 
                style="width:60%;padding: 5px"
                placeholder="如果localhost上报失败试试局域网ip"/>
            </setting-item>

            `
        return eleStr
    }

    let hostsEleStr = ""
    for (const host of config.hosts) {
        hostsEleStr += creatHostEleStr(host);
    }
    let html = `
    <div class="config_view llonebot">
        <setting-section>
            <setting-panel>
                <setting-list class="wrap">
                    <setting-item class="vertical-list-item" data-direction="row">
                        <setting-text>监听端口</setting-text>
                        <input id="port" type="number" value="${config.port}"/>
                    </setting-item>
                    <div>
                        <button id="addHost" class="q-button">添加上报地址</button>
                    </div>
                    <div id="hostItems">
                        ${hostsEleStr}
                    </div>
                    <button id="save" class="q-button">保存(监听端口重启QQ后生效)</button>
                </setting-list>
            </setting-panel>
            <setting-panel>
                <setting-item data-direction="row" class="hostItem vertical-list-item">
                    <div>
                        <div>上报文件进行base64编码</div>
                        <div class="tips">不开启时，上报文件将以本地路径形式发送</div>
                    </div>
                    <setting-switch id="switchBase64" ${config.enableBase64 ? "is-active" : ""}></setting-switch>
                </setting-item>
                <setting-item data-direction="row" class="hostItem vertical-list-item">
                    <div>
                        <div>debug模式</div>
                        <div class="tips">开启后上报消息添加raw字段附带原始消息</div>
                    </div>
                    <setting-switch id="debug" ${config.debug ? "is-active" : ""}></setting-switch>
                </setting-item>
                <setting-item data-direction="row" class="hostItem vertical-list-item">
                    <div>
                        <div>上报自身消息</div>
                        <div class="tips">开启后上报自己发出的消息</div>
                    </div>
                    <setting-switch id="reportSelfMessage" ${config.reportSelfMessage ? "is-active" : ""}></setting-switch>
                </setting-item>
                <setting-item data-direction="row" class="hostItem vertical-list-item">
                    <div>
                        <div>日志</div>
                        <div class="tips">日志目录:${window.LiteLoader.plugins["LLOneBot"].path.data}</div>
                    </div>
                    <setting-switch id="log" ${config.log ? "is-active" : ""}></setting-switch>
                </setting-item>
            </setting-panel>
        </setting-section>
    </div>
    <style>
        setting-panel {
            padding: 10px;
        }
        .tips {
            font-size: 0.75rem;
        }
        @media (prefers-color-scheme: dark){
            .llonebot input {
                color: white;
            }
        }
    </style>
    `

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");


    function addHostEle(initValue: string = "") {
        let addressDoc = parser.parseFromString(creatHostEleStr(initValue), "text/html");
        let addressEle = addressDoc.querySelector("setting-item")
        let hostItemsEle = document.getElementById("hostItems");
        hostItemsEle.appendChild(addressEle);
    }


    doc.getElementById("addHost").addEventListener("click", () => addHostEle())

    function switchClick(eleId: string, configKey: string) {
        doc.getElementById(eleId)?.addEventListener("click", (e) => {
            const switchEle = e.target as HTMLInputElement
            if (config[configKey]) {
                config[configKey] = false
                switchEle.removeAttribute("is-active")
            } else {
                config[configKey] = true
                switchEle.setAttribute("is-active", "")
            }
            window.llonebot.setConfig(config)
        })
    }

    switchClick("debug", "debug");
    switchClick("switchBase64", "enableBase64");
    switchClick("reportSelfMessage", "reportSelfMessage");
    switchClick("log", "log");

    doc.getElementById("save")?.addEventListener("click",
        () => {
            const portEle: HTMLInputElement = document.getElementById("port") as HTMLInputElement
            const hostEles: HTMLCollectionOf<HTMLInputElement> = document.getElementsByClassName("host") as HTMLCollectionOf<HTMLInputElement>;
            // const port = doc.querySelector("input[type=number]")?.value
            // const host = doc.querySelector("input[type=text]")?.value
            // 获取端口和host
            const port = portEle.value
            let hosts: string[] = [];
            for (const hostEle of hostEles) {
                if (hostEle.value) {
                    hosts.push(hostEle.value);
                }
            }
            config.port = parseInt(port);
            config.hosts = hosts;
            window.llonebot.setConfig(config);
            alert("保存成功");
        })


    doc.body.childNodes.forEach(node => {
        view.appendChild(node);
    });


}

setTimeout(onLoad, 5000)

export {
    onSettingWindowCreated
}
