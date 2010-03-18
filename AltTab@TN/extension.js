/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Big = imports.gi.Big;
const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;
const Tweener = imports.ui.tweener;

const Main = imports.ui.main;

const FADE_TIME = 0.05;
const POPUP_ARROW_COLOR = new Clutter.Color();
POPUP_ARROW_COLOR.from_pixel(0xffffffff);
const POPUP_UNFOCUSED_ARROW_COLOR = new Clutter.Color();
POPUP_UNFOCUSED_ARROW_COLOR.from_pixel(0x808080ff);
const TRANSPARENT_COLOR = new Clutter.Color();
TRANSPARENT_COLOR.from_pixel(0x00000000);

const POPUP_APPICON_SIZE = 96;
const POPUP_LIST_SPACING = 8;
const POPUP_SCROLL_TIME = 0.10; // seconds

const DISABLE_HOVER_TIMEOUT = 500; // milliseconds

const iconSizes = [96, 64, 48, 32, 22];

function mod(a, b) {
    return (a + b) % b;
}

function AltTabPopupCustom() {
    this._init();
}

AltTabPopupCustom.prototype = {
    _init : function() {
        this.actor = new Shell.GenericContainer({ reactive: true });
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._haveModal = false;

        this._currentApp = 0;
        this._currentWindow = 0;
        this._motionTimeoutId = 0;

        // Initially disable hover so we ignore the enter-event if
        // the switcher appears underneath the current pointer location
        this._disableHover();

        global.stage.add_actor(this.actor);
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = global.screen_width;
        alloc.natural_size = global.screen_width;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        alloc.min_size = global.screen_height;
        alloc.natural_size = global.screen_height;
    },

    _allocate: function (actor, box, flags) {
        let childBox = new Clutter.ActorBox();
        let focus = global.get_focus_monitor();
        
        // Allocate the appSwitcher
        // We select a size based on an icon size that does not overflow the screen
        let [childMinHeight, childNaturalHeight] = this._appSwitcher.actor.get_preferred_height(focus.width - POPUP_LIST_SPACING * 2);
        let [childMinWidth, childNaturalWidth] = this._appSwitcher.actor.get_preferred_width(childNaturalHeight);
        childBox.x1 = Math.max(POPUP_LIST_SPACING, focus.x + Math.floor((focus.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(childBox.x1 + focus.width - POPUP_LIST_SPACING * 2, childBox.x1 + childNaturalWidth);
        childBox.y1 = focus.y + Math.floor((focus.height - childNaturalHeight) / 2);
        childBox.y2 = childBox.y1 + childNaturalHeight;
        this._appSwitcher.actor.allocate(childBox, flags);
        
    },

    show : function(backward) {
        let tracker = Shell.WindowTracker.get_default();
        let apps = tracker.get_running_apps ("");

        if (!apps.length)
            return false;

        if (!Main.pushModal(this.actor))
            return false;
        this._haveModal = true;

        this._keyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._keyPressEvent));
        this._keyReleaseEventId = global.stage.connect('key-release-event', Lang.bind(this, this._keyReleaseEvent));

        this.actor.connect('button-press-event', Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));

        this._appSwitcher = new AppSwitcher(apps);
        this.actor.add_actor(this._appSwitcher.actor);
        this._appSwitcher.connect('item-activated', Lang.bind(this, this._appActivated));
        this._appSwitcher.connect('item-entered', Lang.bind(this, this._appEntered));

        this._appIcons = this._appSwitcher.icons;

        // Make the initial selection
        if (this._appIcons.length == 1) {
            if (!backward && this._appIcons[0].cachedWindows.length > 1) {
                // For compatibility with the multi-app case below
                this._select(0, 1, true);
            } else
                this._select(0);
        } else if (backward) {
            this._select(this._appIcons.length - 1);
        } else {
                this._select(1);
        }

        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (Have to do this after updating
        // selection.)
        let mods = global.get_modifier_keys();
        if (!(mods & Gdk.ModifierType.MOD1_MASK)) {
            this._finish();
            return false;
        }

        return true;
    },

    _nextApp : function() {
        return mod(this._currentApp + 1, this._appIcons.length);
    },
    _previousApp : function() {
        return mod(this._currentApp - 1, this._appIcons.length);
    },
    _nextWindow : function() {
        return mod(this._currentWindow + 1,
                   this._appIcons[this._currentApp].cachedWindows.length);
    },
    _previousWindow : function() {
        return mod(this._currentWindow - 1,
                   this._appIcons[this._currentApp].cachedWindows.length);
    },

    _keyPressEvent : function(actor, event) {
        let keysym = event.get_key_symbol();
        let shift = (Shell.get_event_state(event) & Clutter.ModifierType.SHIFT_MASK);

        this._disableHover();

        // The WASD stuff is for debugging in Xephyr, where the arrow
        // keys aren't mapped correctly

        if (keysym == Clutter.Escape){
            this.destroy();
        } else {
            if (keysym == Clutter.Tab)
                this._select(shift ? this._previousApp() : this._nextApp());
            else if (keysym == Clutter.Left || keysym == Clutter.a)
                this._select(this._previousApp());
            else if (keysym == Clutter.Right || keysym == Clutter.d)
                this._select(this._nextApp());
            else if (keysym == Clutter.Return)
                this._finish();
        }

        return true;
    },

    _keyReleaseEvent : function(actor, event) {
        let keysym = event.get_key_symbol();

        if (keysym == Clutter.Alt_L || keysym == Clutter.Alt_R)
            this._finish();

        return true;
    },

    _onScroll : function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP) {
			this._select(this._previousApp());
        } else if (direction == Clutter.ScrollDirection.DOWN) {
			this._select(this._nextApp());
        }
    },

    _clickedOutside : function(actor, event) {
        this.destroy();
    },

    _appActivated : function(appSwitcher, n) {
        // If the user clicks on the selected app, activate the
        // selected window; otherwise (eg, they click on an app while
        // !mouseActive) activate the first window of the clicked-on
        // app.

        for (let i = app.cachedWindows.length - 1; i >= 0; i--) {
			if(i != this._currentWindow){
				if (app.cachedWindows[i].get_workspace() == activeWorkspace){
					if(!app.cachedWindows[i].is_hidden())
						Main.activateWindow(app.cachedWindows[i]);
				}
			} else {
				Main.activateWindow(app.cachedWindows[i]);
			}
		}
        this.destroy();
    },

    _appEntered : function(appSwitcher, n) {
        if (!this._mouseActive)
            return;

        this._select(n);
    },

    _disableHover : function() {
        this._mouseActive = false;

        if (this._motionTimeoutId != 0)
            Mainloop.source_remove(this._motionTimeoutId);

        this._motionTimeoutId = Mainloop.timeout_add(DISABLE_HOVER_TIMEOUT, Lang.bind(this, this._mouseTimedOut));
    },

    _mouseTimedOut : function() {
        this._motionTimeoutId = 0;
        this._mouseActive = true;
    },

    _finish : function() {
        let app = this._appIcons[this._currentApp];
        let activeWorkspace = global.screen.get_active_workspace();

        for (let i = app.cachedWindows.length - 1; i >= 0; i--) {
			if(i != this._currentWindow){
				if (app.cachedWindows[i].get_workspace() == activeWorkspace){
					if(!app.cachedWindows[i].is_hidden())
						Main.activateWindow(app.cachedWindows[i]);
				}
			} else {
				Main.activateWindow(app.cachedWindows[i]);
			}
		}
        this.destroy();
    },

    destroy : function() {
		this.actor.opacity = 255;
        Tweener.addTween(this.actor,
                        { opacity: 0,
                          time: FADE_TIME,
                          transition: "linear",
						  onComplete: Lang.bind(this, function() {
							this.actor.destroy(); })
						  });
	  },

    _onDestroy : function() {
        if (this._haveModal)
            Main.popModal(this.actor);

        if (this._keyPressEventId)
            global.stage.disconnect(this._keyPressEventId);
        if (this._keyReleaseEventId)
            global.stage.disconnect(this._keyReleaseEventId);

        if (this._motionTimeoutId != 0)
            Mainloop.source_remove(this._motionTimeoutId);
    },

    /**
     * _select:
     * @app: index of the app to select
     * @window: (optional) index of which of @app's windows to select
     * @forceAppFocus: optional flag, see below
     *
     * Selects the indicated @app, and optional @window, and sets
     * this._thumbnailsFocused appropriately to indicate whether the
     * arrow keys should act on the app list or the thumbnail list.
     *
     * If @app is specified and @window is unspecified or %null, then
     * the app is highlighted (ie, given a light background), and the
     * current thumbnail list, if any, is destroyed. If @app has
     * multiple windows, and @forceAppFocus is not %true, then a
     * timeout is started to open a thumbnail list.
     *
     * If @app and @window are specified (and @forceAppFocus is not),
     * then @app will be outlined, a thumbnail list will be created
     * and focused (if it hasn't been already), and the @window'th
     * window in it will be highlighted.
     *
     * If @app and @window are specified and @forceAppFocus is %true,
     * then @app will be highlighted, and @window outlined, and the
     * app list will have the keyboard focus.
     */
    _select : function(app, window, forceAppFocus) {

        this._currentApp = app;
        this._currentWindow = window ? window : 0;
        this._appSwitcher.highlight(app);

        if (window != null) {
            this._currentWindow = window;
		}
    }

};

function SwitcherList(squareItems) {
    this._init(squareItems);
}

SwitcherList.prototype = {
    _init : function(squareItems) {
        this.actor = new St.BoxLayout({ style_class: 'switcher-list-tn' });

        // Here we use a GenericContainer so that we can force all the
        // children except the separator to have the same width.
        this._list = new Shell.GenericContainer();
        this._list.spacing = POPUP_LIST_SPACING;

        this._list.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._list.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._list.connect('allocate', Lang.bind(this, this._allocate));

        this._clipBin = new St.Bin({style_class: 'cbin'});
        this._clipBin.child = this._list;
        this.actor.add_actor(this._clipBin);

        this._leftGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-left', vertical: true});
        this._rightGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-right', vertical: true});
        this.actor.add_actor(this._leftGradient);
        this.actor.add_actor(this._rightGradient);

        // Those arrows indicate whether scrolling in one direction is possible
        this._leftArrow = new St.DrawingArea();
        this._leftArrow.connect('repaint', Lang.bind(this,
                    function (area) {
                    Shell.draw_box_pointer(area, Shell.PointerDirection.LEFT, TRANSPARENT_COLOR, POPUP_ARROW_COLOR);
                    }));

        this._rightArrow = new St.DrawingArea();
        this._rightArrow.connect('repaint', Lang.bind(this,
                    function (area) {
                    Shell.draw_box_pointer(area, Shell.PointerDirection.RIGHT, TRANSPARENT_COLOR, POPUP_ARROW_COLOR);
                    }));

        this._leftGradient.add_actor(this._leftArrow);
        this._rightGradient.add_actor(this._rightArrow);

        this._items = [];
        this._highlighted = -1;
        this._separator = null;
        this._squareItems = squareItems;
        this._scrollable = false;
    },

    addItem : function(item) {
        let bbox = new St.Clickable({ style_class: 'item-box',
                                      reactive: true });

        bbox.set_child(item);
        this._list.add_actor(bbox);

        let n = this._items.length;
        bbox.connect('clicked', Lang.bind(this, function () {
                                               this._itemActivated(n);
                                          }));
        bbox.connect('enter-event', Lang.bind(this, function () {
                                                  this._itemEntered(n);
                                              }));

        this._items.push(bbox);
    },

    addSeparator: function () {
        let box = new St.Bin({ style_class: 'separator' })
        this._separator = box;
        this._list.add_actor(box);
    },

    highlight: function(index) {
        if (this._highlighted != -1)
            this._items[this._highlighted].style_class = 'item-box';

        this._highlighted = index;

        if (this._highlighted != -1) {
			this._items[this._highlighted].style_class = 'selected-item-box';
        }

        let monitor = global.get_focus_monitor();
        let itemSize = this._items[index].allocation.x2 - this._items[index].allocation.x1;
        let [posX, posY] = this._items[index].get_transformed_position();
        posX += this.actor.x;

        if (posX + itemSize > monitor.width)
            this._scrollToRight();
        else if (posX < 0)
            this._scrollToLeft();

    },

    _scrollToLeft : function() {
        let x = this._items[this._highlighted].allocation.x1;
        this._rightGradient.show();
        Tweener.addTween(this._list, { anchor_x: x,
                time: POPUP_SCROLL_TIME,
                transition: 'easeOutQuad',
                onComplete: Lang.bind(this, function () {
                    if (this._highlighted == 0)
                    this._leftGradient.hide();
                    })
                });
    },

    _scolloRight : function() {
        let monitor = global.get_focus_monitor();
        let padding = this.actor.get_theme_node().get_horizontal_padding();
        let x = this._items[this._highlighted].allocation.x2 - monitor.width + padding + POPUP_LIST_SPACING * 2;
        this._leftGradient.show();
        Tweener.addTween(this._list, { anchor_x: x,
               time: POPUP_SCROLL_TIME,
               transition: 'easeOutQuad',
               onComplete: Lang.bind(this, function () {
                   if (this._highlighted == this._items.length - 1)
                   this._rightGradient.hide();
                   })
       });
    },

    _itemActivated: function(n) {
        this.emit('item-activated', n);
    },

    _itemEntered: function(n) {
        this.emit('item-entered', n);
    },

    _maxChildWidth: function (forHeight) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);

            if (this._squareItems) {
                let [childMin, childNat] = this._items[i].get_preferred_height(-1);
                maxChildMin = Math.max(childMin, maxChildMin);
                maxChildNat = Math.max(childNat, maxChildNat);
            }
        }

        return [maxChildMin, maxChildNat];
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        let [maxChildMin, maxChildNat] = this._maxChildWidth(forHeight);

        let separatorWidth = 0;
        if (this._separator) {
            let [sepMin, sepNat] = this._separator.get_preferred_width(forHeight);
            separatorWidth = sepNat + this._list.spacing;
        }

        let totalSpacing = this._list.spacing * (this._items.length - 1);
        alloc.min_size = this._items.length * maxChildMin + separatorWidth + totalSpacing;
        alloc.natural_size = alloc.min_size;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_height(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);
        }

        if (this._squareItems) {
            let [childMin, childNat] = this._maxChildWidth(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = maxChildMin;
        }

        alloc.min_size = maxChildMin;
        alloc.natural_size = maxChildNat;
    },

    _allocate: function (actor, box, flags) {
        let childHeight = box.y2 - box.y1;

        let [maxChildMin, maxChildNat] = this._maxChildWidth(childHeight);
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        let separatorWidth = 0;
        if (this._separator) {
            let [sepMin, sepNat] = this._separator.get_preferred_width(childHeight);
            separatorWidth = sepNat;
            totalSpacing += this._list.spacing;
        }

        let childWidth = Math.floor(Math.max(0, box.x2 - box.x1 - totalSpacing - separatorWidth) / this._items.length);

        let x = 0;
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        let focus = global.get_focus_monitor();
       if (this.actor.allocation.x2 == focus.width - POPUP_LIST_SPACING) {
           if (this._squareItems)
               childWidth = childHeight;
           else
               childWidth = children[0].get_preferred_width(childHeight)[0];
       }
            

        for (let i = 0; i < children.length; i++) {
            if (this._items.indexOf(children[i]) != -1) {
                let [childMin, childNat] = children[i].get_preferred_height(childWidth);
                let vSpacing = (childHeight - childNat) / 2;
                childBox.x1 = x;
                childBox.y1 = vSpacing;
                childBox.x2 = x + childWidth;
                childBox.y2 = childBox.y1 + childNat;
                children[i].allocate(childBox, flags);

                x += this._list.spacing + childWidth;
            } else if (children[i] == this._separator) {
                // We want the separator to be more compact than the rest.
                childBox.x1 = x;
                childBox.y1 = 0;
                childBox.x2 = x + separatorWidth;
                childBox.y2 = childHeight;
                children[i].allocate(childBox, flags);
                x += this._list.spacing + separatorWidth;
            } else {
                // Something else, eg, AppSwitcher's arrows;
                // we don't allocate it.
            }
        }
        


        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let topPadding = this.actor.get_theme_node().get_padding(St.Side.TOP);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);

        // Show the arrows and gradients when scrolling is needed
        if (children[children.length - 1].allocation.x2 > this.actor.width - leftPadding - rightPadding && !this._scrollable) {
            this._leftGradient.set_height(this.actor.height);
            this._leftGradient.x = this.actor.x;
            this._leftGradient.y = this.actor.y;

            this._rightGradient.set_height(this.actor.height);
            this._rightGradient.x = this.actor.x + (this.actor.allocation.x2 - this.actor.allocation.x1) - this._rightGradient.width;
            this._rightGradient.y = this.actor.y;

            let arrowWidth = Math.floor(leftPadding / 3);
            let arrowHeight = arrowWidth * 2;
            this._leftArrow.set_size(arrowWidth, arrowHeight);
            this._leftArrow.set_position(POPUP_LIST_SPACING, this.actor.height / 2 - arrowWidth);

            arrowWidth = Math.floor(rightPadding / 3);
            arrowHeight = arrowWidth * 2;
            this._rightArrow.set_size(arrowWidth, arrowHeight);
            this._rightArrow.set_position(this._rightGradient.width - arrowHeight, this.actor.height / 2 - arrowWidth);

            this._scrollable = true;

            this._leftGradient.hide();
            this._rightGradient.show();
        }
        else if (!this._scrollable){
            this._leftGradient.hide();
            this._rightGradient.hide();
        }

        // Clip the area for scrolling
        this._clipBin.set_clip(0, -topPadding, (this.actor.allocation.x2 - this.actor.allocation.x1) - leftPadding - rightPadding, this.actor.height + bottomPadding);



    }
};

Signals.addSignalMethods(SwitcherList.prototype);

function AppIcon(app,size) {
    this._init(app,size);
}

AppIcon.prototype = {
    _init: function(app,size) {
        this.app = app;
        this.actor = new St.BoxLayout({ style_class: "alt-tab-app",
                                         vertical: true });
        this.icon = null;
        this._iconBin = new St.Bin();

        this.actor.add(this._iconBin, { x_fill: false, y_fill: false } );
        this.label = new St.Label({ text: this.app.get_name() });
        this.actor.add(this.label, { x_fill: false });
    },

    set_size: function(size) {
        this.icon = this.app.create_icon_texture(size);
        this._iconBin.set_size(size, size);
        this._iconBin.child = this.icon;
   }
}

function AppSwitcher(apps) {
    this._init(apps);
}

AppSwitcher.prototype = {
    __proto__ : SwitcherList.prototype,

    _init : function(apps) {
        SwitcherList.prototype._init.call(this, true);

        // Construct the AppIcons, sort by time, add to the popup
        let activeWorkspace = global.screen.get_active_workspace();
        let workspaceIcons = [];
        let otherIcons = [];

		let size = POPUP_APPICON_SIZE;
		width = (apps.length*(size + 16) + 30)
		while ((apps.length*(size + 42) + 30) > global.screen_width){
			size = size - 5;
		}

        for (let i = 0; i < apps.length; i++) {
            let appIcon = new AppIcon(apps[i],size);
            // Cache the window list now; we don't handle dynamic changes here,
            // and we don't want to be continually retrieving it
			appIcon.cachedWindows = appIcon.app.get_windows();
            if (this._hasWindowsOnWorkspace(appIcon, activeWorkspace))
              workspaceIcons.push(appIcon);
            else
              otherIcons.push(appIcon);
        }

        workspaceIcons.sort(Lang.bind(this, this._sortAppIcon));
        otherIcons.sort(Lang.bind(this, this._sortAppIcon));

        this.icons = [];
        this._arrows = [];
        for (let i = 0; i < workspaceIcons.length; i++)
            this._addIcon(workspaceIcons[i]);
        if (workspaceIcons.length > 0 && otherIcons.length > 0)
            this.addSeparator();
        for (let i = 0; i < otherIcons.length; i++)
            this._addIcon(otherIcons[i]);

        this._curApp = -1;
        this._iconSize= 0;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let j = 0;
        while(this._items.length > 1 && this._items[j].style_class != 'item-box') {
                j++;
        }
        let iconPadding = this._items[j].get_theme_node().get_horizontal_padding();
        let [iconMinHeight, iconNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        let iconSpacing = iconNaturalHeight + iconPadding;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        if (this._separator)
           totalSpacing += this._separator.width + this._list.spacing;

        // We just assume the whole screen here due to weirdness happing with the passed width
        let focus = global.get_focus_monitor();
        let availWidth = focus.width - POPUP_LIST_SPACING * 2 - this.actor.get_theme_node().get_horizontal_padding();
        let height = 0;

        for(let i =  0; i < iconSizes.length; i++) {
                this._iconSize = iconSizes[i];
                height = iconSizes[i] + iconSpacing;
                let w = height * this._items.length + totalSpacing;
                if (w <= availWidth)
                        break;
        }

        if (this._items.length == 1) {
            this._iconSize = iconSizes[0];
            height = iconSizes[0] + iconSpacing;
        }

        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _allocate: function (actor, box, flags) {
        for(let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;
            this.icons[i].set_size(this._iconSize);
        }

        // Allocate the main list items
        SwitcherList.prototype._allocate.call(this, actor, box, flags);
    },

    _addIcon : function(appIcon) {
        this.icons.push(appIcon);
        this.addItem(appIcon.actor);
    },

    _hasWindowsOnWorkspace: function(appIcon, workspace) {
        let windows = appIcon.cachedWindows;
        for (let i = 0; i < windows.length; i++) {
            if (windows[i].get_workspace() == workspace)
                return true;
        }
        return false;
    },

    _sortAppIcon : function(appIcon1, appIcon2) {
        return appIcon1.app.compare(appIcon2.app);
    }
};

function _startAppSwitcher(shellwm, binding, window, backwards) {
    let tabPopup = new AltTabPopupCustom();

    if (!tabPopup.show(backwards))
        tabPopup.destroy();
}
    
// Put your extension initialization code here
function main() {
	Main.wm.setKeybindingHandler('switch_windows',Lang.bind(this, _startAppSwitcher));
}
