// 我的：身份、小家、邀请码、成员、退出登录。
const guard = require('../../utils/auth-guard');
const { listMembers, signOut } = require('../../utils/context');
const selection = require('../../utils/selection');
const notify = require('../../utils/notify');
const { relativeTime } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        meLabel: '',
        spaceName: '我们的小家',
        inviteCode: '',
        members: [],
        unreadCount: 0,
        error: '',
        signingOut: false,
    },

    onShow() {
        this.load();
    },

    async load() {
        const context = await guard.check(this);
        if (!context) return;

        const result = await listMembers(context.space.id);
        const members = (result.members || []).map((member) => ({
            isMe: member.user_id === context.meId,
            label: member.user_id === context.meId ? '我' : 'TA',
            joined: relativeTime(member.joined_at),
        }));
        members.sort((a, b) => {
            if (a.isMe === b.isMe) return 0;
            return a.isMe ? -1 : 1;
        });

        notify.setScope(context.space.id, context.meId);
        const unread = await notify.unreadCount();

        this.setData({
            meLabel: context.meName || '已登录',
            spaceName: context.space.name || '我们的小家',
            inviteCode: context.space.invite_code || '',
            members: members,
            unreadCount: unread.count || 0,
            error: '',
        });
    },

    onGoNotice() {
        wx.navigateTo({ url: '/pages/notice/notice' });
    },

    onGoNotifySetting() {
        wx.navigateTo({ url: '/pages/notify-setting/notify-setting' });
    },

    onGoModelSetting() {
        wx.navigateTo({ url: '/pages/model-setting/model-setting' });
    },

    onGoConsumption() {
        wx.navigateTo({ url: '/pages/consumption/consumption' });
    },

    onGoNutrition() {
        wx.navigateTo({ url: '/pages/nutrition/nutrition' });
    },

    onCopyCode() {
        const code = this.data.inviteCode;
        if (!code) return;
        wx.setClipboardData({
            data: code,
            success: () => {
                wx.showToast({ title: '邀请码已复制', icon: 'none' });
            },
        });
    },

    onSignOut() {
        if (this.data.signingOut) return;
        wx.showModal({
            title: '退出登录？',
            content: '退出后需要重新登录才能看到两个人的冰箱，数据不会丢。',
            confirmText: '退出',
            success: async (res) => {
                if (!res.confirm) return;
                this.setData({ signingOut: true });
                await signOut();
                getApp().resetAuth();
                selection.reset();
                this.setData({ signingOut: false });
                wx.reLaunch({ url: '/pages/login/login' });
            },
        });
    },
});
