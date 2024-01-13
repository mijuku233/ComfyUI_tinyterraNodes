import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const CONVERTED_TYPE = "converted-widget";
const GET_CONFIG = Symbol();

function hideWidget(node, widget, suffix = "") {
	widget.origType = widget.type;
	widget.origComputeSize = widget.computeSize;
	widget.origSerializeValue = widget.serializeValue;
	widget.computeSize = () => [0, -4]; // -4 is due to the gap litegraph adds between widgets automatically
	widget.type = CONVERTED_TYPE + suffix;
	widget.serializeValue = () => {
		// Prevent serializing the widget if we have no input linked
		if (!node.inputs) {
			return undefined;
		}
		let node_input = node.inputs.find((i) => i.widget?.name === widget.name);

		if (!node_input || !node_input.link) {
			return undefined;
		}
		return widget.origSerializeValue ? widget.origSerializeValue() : widget.value;
	};

	// Hide any linked widgets, e.g. seed+seedControl
	if (widget.linkedWidgets) {
		for (const w of widget.linkedWidgets) {
			hideWidget(node, w, ":" + widget.name);
		}
	}
}
function deepEqual (obj1, obj2) {
  if (typeof obj1 !== typeof obj2) {
    return false
  }
  if (typeof obj1 !== 'object' || obj1 === null || obj2 === null) {
    return obj1 === obj2
  }
  const keys1 = Object.keys(obj1)
  const keys2 = Object.keys(obj2)
  if (keys1.length !== keys2.length) {
    return false
  }
  for (let key of keys1) {
    if (!deepEqual(obj1[key], obj2[key])) {
      return false
    }
  }
  return true
}
function convertToInput(node, widget, config) {
    console.log('config:', config)
	hideWidget(node, widget);

	const { type } = getWidgetType(config);

	// Add input and store widget config for creating on primitive node
	const sz = node.size;
	node.addInput(widget.name, type, {
		widget: { name: widget.name, [GET_CONFIG]: () => config },
	});

	for (const widget of node.widgets) {
		widget.last_y += LiteGraph.NODE_SLOT_HEIGHT;
	}

	// Restore original size but grow if needed
	node.setSize([Math.max(sz[0], node.size[0]), Math.max(sz[1], node.size[1])]);
}

function getWidgetType(config) {
	// Special handling for COMBO so we restrict links based on the entries
	let type = config[0];
	if (type instanceof Array) {
		type = "COMBO";
	}
	return { type };
}

app.registerExtension({
    name: "comfy.ttN",
    init() {
        const ttNreloadNode = function (node) {
            const nodeType = node.constructor.type;
            const origVals = node.properties.origVals || {};

            const nodeTitle = origVals.title || node.title;
            const nodeColor = origVals.color || node.color;
            const bgColor = origVals.bgcolor || node.bgcolor;
            const oldNode = node
            const options = {
                'size': [...node.size],
                'color': nodeColor,
                'bgcolor': bgColor,
                'pos': [...node.pos]
            }
            
            let inputLinks = []
            let outputLinks = []
            for (const input of node.inputs) {
                if (input.link) { 
                    const input_name = input.name
                    const input_slot = node.findInputSlot(input_name)
                    const input_node = node.getInputNode(input_slot)
                    const input_link = node.getInputLink(input_slot)

                    inputLinks.push([input_link.origin_slot, input_node, input_name])
                }
            }
            for (const output of node.outputs) {
                if (output.links) { 
                    const output_name = output.name

                    for (const linkID of output.links) {
                        const output_link = graph.links[linkID]
                        const output_node = graph._nodes_by_id[output_link.target_id]
                        outputLinks.push([output_name, output_node, output_link.target_slot]) 
                    }  
                }              
            }

            app.graph.remove(node)
            const newNode = app.graph.add(LiteGraph.createNode(nodeType, nodeTitle, options));
            if (newNode?.constructor?.hasOwnProperty('ttNnodeVersion')) {
                newNode.properties.ttNnodeVersion = newNode.constructor.ttNnodeVersion;
            }

            function handleLinks() {
                // re-convert inputs
                for (let w of oldNode.widgets) {
                    if (w.type === 'converted-widget') {
                        const WidgetToConvert = newNode.widgets.find((nw) => nw.name === w.name);
                        for (let i of oldNode.inputs) {
                            if (i.name === w.name) {
                                convertToInput(newNode, WidgetToConvert, i.widget);
                            }
                        }               
                    }
                }
                // replace input and output links
                for (let input of inputLinks) {
                    const [output_slot, output_node, input_name] = input;
                    output_node.connect(output_slot, newNode.id, input_name)
                }
                for (let output of outputLinks) {
                    const [output_name, input_node, input_slot] = output;
                    newNode.connect(output_name, input_node, input_slot)
                }
            }

            // fix widget values
            let values = oldNode.widgets_values;
            if (!values) {
                newNode.widgets.forEach((newWidget, index) => {
                    const oldWidget = oldNode.widgets[index];
                    if (newWidget.name === oldWidget.name && newWidget.type === oldWidget.type) {
                        newWidget.value = oldWidget.value;
                    }
                });
                handleLinks();
                return;
            }
            let pass = false
            const isIterateForwards = values.length <= newNode.widgets.length;
            let vi = isIterateForwards ? 0 : values.length - 1;
            function evalWidgetValues(testValue, newWidg) {
                if (testValue === true || testValue === false) {
                    if (newWidg.options?.on && newWidg.options?.off) {
                        return { value: testValue, pass: true };
                    }
                } else if (typeof testValue === "number") {
                    if (newWidg.options?.min <= testValue && testValue <= newWidg.options?.max) {
                        return { value: testValue, pass: true };
                    }
                } else if (newWidg.options?.values?.includes(testValue)) {
                    return { value: testValue, pass: true };
                } else if (newWidg.inputEl && typeof testValue === "string") {
                    return { value: testValue, pass: true };
                }
                return { value: newWidg.value, pass: false };
            }
            const updateValue = (wi) => {
                const oldWidget = oldNode.widgets[wi];
                let newWidget = newNode.widgets[wi];
                if (newWidget.name === oldWidget.name && newWidget.type === oldWidget.type) {
                    while ((isIterateForwards ? vi < values.length : vi >= 0) && !pass) {
                        let { value, pass } = evalWidgetValues(values[vi], newWidget);
                        if (pass && value !== null) {
                            newWidget.value = value;
                            break;
                        }
                        vi += isIterateForwards ? 1 : -1;
                    }
                    vi++
                    if (!isIterateForwards) {
                        vi = values.length - (newNode.widgets.length - 1 - wi);
                    }
                }
            };
            if (isIterateForwards) {
                for (let wi = 0; wi < newNode.widgets.length; wi++) {
                    updateValue(wi);
                }
            } else {
                for (let wi = newNode.widgets.length - 1; wi >= 0; wi--) {
                    updateValue(wi);
                }
            }
            handleLinks();
        };

        const getNodeMenuOptions = LGraphCanvas.prototype.getNodeMenuOptions;
        LGraphCanvas.prototype.getNodeMenuOptions = function (node) {
            const options = getNodeMenuOptions.apply(this, arguments);
            node.setDirtyCanvas(true, true);

            options.splice(options.length - 1, 0,
                {
                    content: "Reload Node (ttN)",
                    callback: () => {
                        var graphcanvas = LGraphCanvas.active_canvas;
                        if (!graphcanvas.selected_nodes || Object.keys(graphcanvas.selected_nodes).length <= 1) {
                            ttNreloadNode(node);
                        } else {
                            for (var i in graphcanvas.selected_nodes) {
                                ttNreloadNode(graphcanvas.selected_nodes[i]);
                            }
                        }
                    }
                }
            );
            return options;
        };

        // Canvas Menu
        const getCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;
        LGraphCanvas.prototype.getCanvasMenuOptions = function () {
            const options = getCanvasMenuOptions.apply(this, arguments);
            options.push(null,
                {
                    content: "📜Groups Map (EasyUse)",
                    callback: () => {
                        const locale = localStorage['AGL.Locale'] || localStorage['Comfy.Settings.AGL.Locale'] || 'en-US'
                        const groups = app.canvas.graph._groups
                        let nodes = app.canvas.graph._nodes
                        let groups_len = groups.length
                        let div =
                            document.querySelector('#easyuse_groups_map') ||
                            document.createElement('div')
                        div.id = 'easyuse_groups_map'
                        div.style = `
                              flex-direction: column;
                              align-items: end;
			      align-items: flex-start;
                              display:flex;position: absolute; 
                              top: 2px; left: 2px; width: 180px;
                              border-radius:12px;
                              min-height:100px; 
                              max-height:400px;
                              color: var(--descrip-text);
                              background-color: var(--comfy-menu-bg);
                              padding: 10px 4px; 
                              border: 1px solid var(--border-color);z-index: 999999999;padding-top: 0;`

                        div.innerHTML = ''
                        let btn = document.createElement('div')
                        btn.style = `display: flex;
                            width: calc(100% - 8px);
                            justify-content: space-between;
                            align-items: center;
                            padding: 0 6px;
                            height: 44px;`
                        let hideBtn = document.createElement('button')
                        let textB = document.createElement('p')
                        btn.appendChild(textB)
                        btn.appendChild(hideBtn)
                        textB.style.fontSize = '11px'
                        textB.innerHTML =  locale == 'zh-CN' ? `<b>管理组 (EasyUse)</b>` : `<b>Groups Map (EasyUse)</b>`
                        hideBtn.style = `float: right;color: var(--input-text);border-radius:6px;font-size:9px;
                            background-color: var(--comfy-input-bg); border: 1px solid var(--border-color);cursor: pointer;padding: 5px;aspect-ratio: 1 / 1;`
                        hideBtn.addEventListener('click', () => {div.style.display = 'none'})
                        hideBtn.innerText = '❌'
                        div.appendChild(btn)

                        div.addEventListener('mousedown', function (e) {
                            var startX = e.clientX
                            var startY = e.clientY
                            var offsetX = div.offsetLeft
                            var offsetY = div.offsetTop

                            function moveBox (e) {
                              var newX = e.clientX
                              var newY = e.clientY
                              var deltaX = newX - startX
                              var deltaY = newY - startY
                              div.style.left = offsetX + deltaX + 'px'
                              div.style.top = offsetY + deltaY + 'px'
                            }

                            function stopMoving () {
                              document.removeEventListener('mousemove', moveBox)
                              document.removeEventListener('mouseup', stopMoving)
                            }

                            document.addEventListener('mousemove', moveBox)
                            document.addEventListener('mouseup', stopMoving)
                        })

                        function updateGroups(groups, groupsDiv){
                            for (let index in groups) {
                                const group = groups[index]
                                const title = group.title
                                const show_text = locale == 'zh-CN' ? '启用中' : 'Always'
                                const hide_text = locale == 'zh-CN' ? '已忽略' : 'Bypass'
                                const mute_text = locale == 'zh-CN' ? '已停用' : 'Never'
                                let group_item = document.createElement('div')
                                let group_item_style = `justify-content: space-between;display:flex;background-color: var(--comfy-input-bg);border-radius: 5px;border:1px solid var(--border-color);margin-top:5px;`
                                group_item.addEventListener("mouseover",event=>{
                                    event.preventDefault()
                                    group_item.style = group_item_style + "filter:brightness(1.2);"
                                })
                                group_item.addEventListener("mouseleave",event=>{
                                    event.preventDefault()
                                    group_item.style = group_item_style + "filter:brightness(1);"
                                })
                                group_item.style = group_item_style
                                // 标题
                                let text_group_title = document.createElement('div')
                                text_group_title.style = `flex:1;font-size:12px;color:var(--input-text);padding:4px;white-space: nowrap;overflow: hidden;text-overflow: ellipsis;`
                                text_group_title.innerHTML = `${title}`
                                group_item.append(text_group_title)
                                // 按钮组
                                let buttons = document.createElement('div')
                                group.recomputeInsideNodes();
                                const nodesInGroup = group._nodes;
                                let isGroupShow = nodesInGroup && nodesInGroup.length>0 && nodesInGroup[0].mode == 0
                                let isGroupMute = nodesInGroup && nodesInGroup.length>0 && nodesInGroup[0].mode == 2
                                let go_btn = document.createElement('button')
                                go_btn.style = "margin-right:6px;cursor:pointer;font-size:10px;padding:2px 4px;color:var(--input-text);background-color: var(--comfy-input-bg);border: 1px solid var(--border-color);border-radius:4px;"
                                go_btn.innerText = "Go"
                                go_btn.addEventListener('click', () => {
                                    app.canvas.ds.offset[0] =  -group.pos[0] - group.size[0] * 0.5 + (app.canvas.canvas.width * 0.5) / app.canvas.ds.scale;
                                    app.canvas.ds.offset[1] = -group.pos[1] - group.size[1] * 0.5 + (app.canvas.canvas.height * 0.5) / app.canvas.ds.scale;
                                    app.canvas.setDirty(true, true);
                                    app.canvas.setZoom(1)
                                })
                                buttons.append(go_btn)
                                let see_btn = document.createElement('button')
                                let defaultStyle = `cursor:pointer;font-size:10px;;padding:2px;border: 1px solid var(--border-color);border-radius:4px;`
                                see_btn.style = isGroupMute ? `background-color:var(--error-text);color:var(--input-text);` + defaultStyle : (isGroupShow ? `background-color:#006691;color:var(--input-text);` + defaultStyle : `background-color: var(--comfy-input-bg);color:var(--descrip-text);` + defaultStyle)
                                see_btn.innerText = isGroupMute ? mute_text : (isGroupShow ? show_text : hide_text)
                                let pressTimer
                                let firstTime =0, lastTime =0
                                let isHolding = false
                                see_btn.addEventListener('click', () => {
                                    if(isHolding){
                                        isHolding = false
                                        return
                                    }
                                    for (const node of nodesInGroup) {
                                        node.mode = isGroupShow ? 4 : 0;
                                        node.graph.change();
                                    }
                                    isGroupShow = nodesInGroup[0].mode == 0 ? true : false
                                    isGroupMute = nodesInGroup[0].mode == 2 ? true : false
                                    see_btn.style = isGroupMute ? `background-color:var(--error-text);color:var(--input-text);` + defaultStyle : (isGroupShow ? `background-color:#006691;color:var(--input-text);` + defaultStyle : `background-color: var(--comfy-input-bg);color:var(--descrip-text);` + defaultStyle)
                                    see_btn.innerText = isGroupMute ? mute_text : (isGroupShow ? show_text : hide_text)
                                })
                                see_btn.addEventListener('mousedown', () => {
                                    firstTime = new Date().getTime();
                                    clearTimeout(pressTimer);
                                    pressTimer = setTimeout(_=>{
                                        for (const node of nodesInGroup) {
                                            node.mode = isGroupMute ? 0 : 2;
                                            node.graph.change();
                                        }
                                        isGroupShow = nodesInGroup[0].mode == 0 ? true : false
                                        isGroupMute = nodesInGroup[0].mode == 2 ? true : false
                                        see_btn.style = isGroupMute ? `background-color:var(--error-text);color:var(--input-text);` + defaultStyle : (isGroupShow ? `background-color:#006691;color:var(--input-text);` + defaultStyle : `background-color: var(--comfy-input-bg);color:var(--descrip-text);` + defaultStyle)
                                        see_btn.innerText = isGroupMute ? mute_text : (isGroupShow ? show_text : hide_text)
                                    },500)
                                })
                                see_btn.addEventListener('mouseup', () => {
                                    lastTime = new Date().getTime();
                                    if(lastTime - firstTime > 500) isHolding = true
                                    clearTimeout(pressTimer);
                                })
                                buttons.append(see_btn)
                                group_item.append(buttons)

                                groupsDiv.append(group_item)
                            }

                        }

                        let groupsDiv =  document.createElement('div')
                        groupsDiv.style = `overflow-y: auto;max-height: 400px;height:100%;width: 100%;`

                        updateGroups(groups, groupsDiv)

                        div.appendChild(groupsDiv)

                        let remarkDiv =  document.createElement('p')
                        remarkDiv.style = `text-align:center; font-size:10px; padding:0 10px;color:var(--descrip-text)`
                        remarkDiv.innerText = locale == 'zh-CN' ? "长按设置为静音" : "LongPress set to never"
                        div.appendChild(groupsDiv)
                        div.appendChild(remarkDiv)

                        let graphDiv = document.getElementById("graph-canvas")
                        graphDiv.addEventListener('mouseover', async () => {
                            let n = (await app.graphToPrompt()).output
                            if (!deepEqual(n, nodes)) {
                              groupsDiv.innerHTML = ``
                              let new_groups = app.canvas.graph._groups
                              updateGroups(new_groups, groupsDiv)
                            }
                        })
                        if (!document.querySelector('#easyuse_groups_map')){
                            document.body.appendChild(div)
                        }

                    }
                },
            );
            return options;
        };
    },
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name.startsWith("ttN")) {
            const origOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
                let nodeVersion = nodeData.input.hidden?.ttNnodeVersion ? nodeData.input.hidden.ttNnodeVersion : null;
                nodeType.ttNnodeVersion = nodeVersion;
                this.properties['ttNnodeVersion'] = this.properties['ttNnodeVersion'] ? this.properties['ttNnodeVersion'] : nodeVersion;
                if (this.properties['ttNnodeVersion'] !== nodeVersion) {
                    if (!this.properties['origVals']) {
                        this.properties['origVals'] = { bgcolor: this.bgcolor, color: this.color, title: this.title }
                    }
                    this.bgcolor = "#d82129";
                    this.color = "#bd000f";
                    this.title = this.title.includes("Node Version Mismatch") ? this.title : this.title + " - Node Version Mismatch"
                } else if (this.properties['origVals']) {
                    this.bgcolor = this.properties.origVals.bgcolor;
                    this.color = this.properties.origVals.color;
                    this.title = this.properties.origVals.title;
                    delete this.properties['origVals']
                }
                return r;
            };
        }
        if (nodeData.name === "ttN textDebug") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                const w = ComfyWidgets["STRING"](this, "text", ["STRING", { multiline: true }], app).widget;
                w.inputEl.readOnly = true;
                w.inputEl.style.opacity = 0.7;
                return r;
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);

                for (const widget of this.widgets) {
                    if (widget.type === "customtext"){
                        widget.value = message.text.join('');
                    }
                }
                
                this.onResize?.(this.size);
            };
        }
    },
    nodeCreated(node) {
        if (node.getTitle() === "pipeLoader") {
            for (let widget of node.widgets) {
                if (widget.name === "control_after_generate") {
                    widget.value = "fixed"
                }
            }
        }
    },
});


// ttN Dropdown
var styleElement = document.createElement("style");
const cssCode = `
.ttN-dropdown, .ttN-nested-dropdown {
    position: relative;
    box-sizing: border-box;
    background-color: #171717;
    box-shadow: 0 4px 4px rgba(255, 255, 255, .25);
    padding: 0;
    margin: 0;
    list-style: none;
    z-index: 1000;
    overflow: visible;
    max-height: fit-content;
    max-width: fit-content;
}

.ttN-dropdown {
    position: absolute;
    border-radius: 0;
}

/* Style for final items */
.ttN-dropdown li.item, .ttN-nested-dropdown li.item {
    font-weight: normal;
    min-width: max-content;
}

/* Style for folders (parent items) */
.ttN-dropdown li.folder, .ttN-nested-dropdown li.folder {
    cursor: default;
    position: relative;
    border-right: 3px solid cyan;
}

.ttN-dropdown li.folder::after, .ttN-nested-dropdown li.folder::after {
    content: ">"; 
    position: absolute; 
    right: 2px; 
    font-weight: normal;
}

.ttN-dropdown li, .ttN-nested-dropdown li {
    padding: 4px 10px;
    cursor: pointer;
    font-family: system-ui;
    font-size: 0.7rem;
    position: relative; 
}

/* Style for nested dropdowns */
.ttN-nested-dropdown {
    position: absolute;
    top: 0;
    left: 100%;
    margin: 0;
    border: none;
    display: none;
}

.ttN-dropdown li.selected > .ttN-nested-dropdown,
.ttN-nested-dropdown li.selected > .ttN-nested-dropdown {
    display: block;
    border: none;
}
  
.ttN-dropdown li.selected,
.ttN-nested-dropdown li.selected {
    background-color: #e5e5e5;
    border: none;
}
`
styleElement.innerHTML = cssCode
document.head.appendChild(styleElement);

let activeDropdown = null;

export function ttN_RemoveDropdown() {
    if (activeDropdown) {
        activeDropdown.removeEventListeners();
        activeDropdown.dropdown.remove();
        activeDropdown = null;
    }
}

class Dropdown {
    constructor(inputEl, suggestions, onSelect, isDict = false) {
        this.dropdown = document.createElement('ul');
        this.dropdown.setAttribute('role', 'listbox');
        this.dropdown.classList.add('ttN-dropdown');
        this.selectedIndex = -1;
        this.inputEl = inputEl;
        this.suggestions = suggestions;
        this.onSelect = onSelect;
        this.isDict = isDict;

        this.focusedDropdown = this.dropdown;

        this.buildDropdown();

        this.onKeyDownBound = this.onKeyDown.bind(this);
        this.onWheelBound = this.onWheel.bind(this);
        this.onClickBound = this.onClick.bind(this);

        this.addEventListeners();
    }

    buildDropdown() {
        if (this.isDict) {
            this.buildNestedDropdown(this.suggestions, this.dropdown);
        } else {
            this.suggestions.forEach((suggestion, index) => {
                this.addListItem(suggestion, index, this.dropdown);
            });
        }

        const inputRect = this.inputEl.getBoundingClientRect();
        this.dropdown.style.top = (inputRect.top + inputRect.height - 10) + 'px';
        this.dropdown.style.left = inputRect.left + 'px';

        document.body.appendChild(this.dropdown);
        activeDropdown = this;
    }

    buildNestedDropdown(dictionary, parentElement) {
        let index = 0;
        Object.keys(dictionary).forEach((key) => {
            const item = dictionary[key];
            if (typeof item === "object" && item !== null) {
                const nestedDropdown = document.createElement('ul');
                nestedDropdown.setAttribute('role', 'listbox');
                nestedDropdown.classList.add('ttN-nested-dropdown');
                const parentListItem = document.createElement('li');
                parentListItem.classList.add('folder');
                parentListItem.textContent = key;
                parentListItem.appendChild(nestedDropdown);
                parentListItem.addEventListener('mouseover', this.onMouseOver.bind(this, index, parentElement));
                parentElement.appendChild(parentListItem);
                this.buildNestedDropdown(item, nestedDropdown);
                index = index + 1;
            } else {
                const listItem = document.createElement('li');
                listItem.classList.add('item');
                listItem.setAttribute('role', 'option');
                listItem.textContent = key;
                listItem.addEventListener('mouseover', this.onMouseOver.bind(this, index, parentElement));
                listItem.addEventListener('mousedown', this.onMouseDown.bind(this, key));
                parentElement.appendChild(listItem);
                index = index + 1;
            }
        });
    }

    addListItem(item, index, parentElement) {
        const listItem = document.createElement('li');
        listItem.setAttribute('role', 'option');
        listItem.textContent = item;
        listItem.addEventListener('mouseover', this.onMouseOver.bind(this, index));
        listItem.addEventListener('mousedown', this.onMouseDown.bind(this, item));
        parentElement.appendChild(listItem);
    }

    addEventListeners() {
        document.addEventListener('keydown', this.onKeyDownBound);
        this.dropdown.addEventListener('wheel', this.onWheelBound);
        document.addEventListener('click', this.onClickBound);
    }

    removeEventListeners() {
        document.removeEventListener('keydown', this.onKeyDownBound);
        this.dropdown.removeEventListener('wheel', this.onWheelBound);
        document.removeEventListener('click', this.onClickBound);
    }

    onMouseOver(index, parentElement) {
        if (parentElement) {
            this.focusedDropdown = parentElement;
        }
        this.selectedIndex = index;
        this.updateSelection();
    }

    onMouseOut() {
        this.selectedIndex = -1;
        this.updateSelection();
    }

    onMouseDown(suggestion, event) {
        event.preventDefault();
        this.onSelect(suggestion);
        this.dropdown.remove();
        this.removeEventListeners();
    }

    onKeyDown(event) {
        const enterKeyCode = 13;
        const escKeyCode = 27;
        const arrowUpKeyCode = 38;
        const arrowDownKeyCode = 40;
        const arrowRightKeyCode = 39;
        const arrowLeftKeyCode = 37;
        const tabKeyCode = 9;

        const items = Array.from(this.focusedDropdown.children);
        const selectedItem = items[this.selectedIndex];

        if (activeDropdown) {
            if (event.keyCode === arrowUpKeyCode) {
                event.preventDefault();
                this.selectedIndex = Math.max(0, this.selectedIndex - 1);
                this.updateSelection();
            }

            else if (event.keyCode === arrowDownKeyCode) {
                event.preventDefault();
                this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
                this.updateSelection();
            }

            else if (event.keyCode === arrowRightKeyCode) {
                event.preventDefault();
                if (selectedItem && selectedItem.classList.contains('folder')) {
                    const nestedDropdown = selectedItem.querySelector('.ttN-nested-dropdown');
                    if (nestedDropdown) {
                        this.focusedDropdown = nestedDropdown;
                        this.selectedIndex = 0;
                        this.updateSelection();
                    }
                }
            }

            else if (event.keyCode === arrowLeftKeyCode && this.focusedDropdown !== this.dropdown) {
                const parentDropdown = this.focusedDropdown.closest('.ttN-dropdown, .ttN-nested-dropdown').parentNode.closest('.ttN-dropdown, .ttN-nested-dropdown');
                if (parentDropdown) {
                    this.focusedDropdown = parentDropdown;
                    this.selectedIndex = Array.from(parentDropdown.children).indexOf(this.focusedDropdown.parentNode);
                    this.updateSelection();
                }
            }

            else if ((event.keyCode === enterKeyCode || event.keyCode === tabKeyCode) && this.selectedIndex >= 0) {
                event.preventDefault();
                if (selectedItem.classList.contains('item')) {
                    this.onSelect(items[this.selectedIndex].textContent);
                    this.dropdown.remove();
                    this.removeEventListeners();
                }
                
                const nestedDropdown = selectedItem.querySelector('.ttN-nested-dropdown');
                if (nestedDropdown) {
                    this.focusedDropdown = nestedDropdown;
                    this.selectedIndex = 0;
                    this.updateSelection();
                }
            }
            
            else if (event.keyCode === escKeyCode) {
                this.dropdown.remove();
                this.removeEventListeners();
            }
        } 
    }

    onWheel(event) {
        const top = parseInt(this.dropdown.style.top);
        if (localStorage.getItem("Comfy.Settings.Comfy.InvertMenuScrolling")) {
            this.dropdown.style.top = (top + (event.deltaY < 0 ? 10 : -10)) + "px";
        } else {
            this.dropdown.style.top = (top + (event.deltaY < 0 ? -10 : 10)) + "px";
        }
    }

    onClick(event) {
        if (!this.dropdown.contains(event.target) && event.target !== this.inputEl) {
            this.dropdown.remove();
            this.removeEventListeners();
        }
    }

    updateSelection() {
        Array.from(this.focusedDropdown.children).forEach((li, index) => {
            if (index === this.selectedIndex) {
                li.classList.add('selected');
            } else {
                li.classList.remove('selected');
            }
        });
    }
}

export function ttN_CreateDropdown(inputEl, suggestions, onSelect, isDict = false) {
    ttN_RemoveDropdown();
    new Dropdown(inputEl, suggestions, onSelect, isDict);
}
