'use strict';
const generateRegisterComponentCode = require('../util/generateRegisterComponentCode');

const START = 'START';
const END = 'END';

function buildIdNodeFromKey(key, builder) {
    const elIdMethod = builder.memberExpression(
        builder.identifier('__component'),
        builder.identifier('elId'));

    return builder.functionCall(elIdMethod, [key]);
}

function getBoundaryForNode(node, pos, builder) {
    const key = (node.type === 'HtmlElement' || node.type === 'CustomTag') && node.getAttributeValue('key');
    const id = node.type === 'HtmlElement' && node.getAttributeValue('id');
    const isKeyDynamic = key ? key.type !== 'Literal' : false;
    const isIdDynamic = id ? id.type !== 'Literal' : false;
    const isDynamic = isKeyDynamic || isIdDynamic;
    let expressionNode;

    if (isDynamic) {
        const boundaryId = key ? buildIdNodeFromKey(key, builder) : id;
        const idVarName = 'marko_componentBoundary' + (pos === START ? 'StartId' : 'EndId');
        const idVar = builder.identifier(idVarName);

        expressionNode = builder.concat(builder.literal('#'), idVar);

        const idVarNode = isDynamic && builder.var(
            idVar,
            boundaryId);

        node.removeAttribute('key');
        node.removeAttribute('id');
        node.setAttributeValue('id', idVar);
        node.insertSiblingBefore(idVarNode);
    } else {
        if (node.type === 'CustomTag') {
            if (key) {
                expressionNode = builder.literal('C' + key.value);
            }
        } else {
            if (key) {
                expressionNode = builder.literal('@' + key.value);
            } else if (id) {
                expressionNode = builder.literal('#' + id.value);
            } else {
                const keyName = pos === START ? '' : '$';
                node.setAttributeValue('key', builder.literal(keyName));
                expressionNode = builder.literal('@' + keyName);
            }
        }
    }

    return {
        isDynamic,
        expression: expressionNode
    };
}

function insertBoundaryNodes(rootNodes, context, builder) {
    let firstNode = rootNodes[0];
    let isDynamic = false;
    let startBoundary;

    if (firstNode.type === 'HtmlElement') {
        startBoundary = getBoundaryForNode(firstNode, START, builder);
        isDynamic = startBoundary.isDynamic;
    } else {
        const extraStart = builder.htmlComment([
            builder.literal('^'),
            builder.memberExpression(builder.identifier('__component'), builder.identifier('id'))
        ]);
        firstNode.insertSiblingBefore(extraStart);
        rootNodes.unshift(extraStart);
        firstNode = extraStart;
    }

    firstNode.setFlag('hasComponentBind');

    let lastNode = rootNodes[rootNodes.length - 1];
    let isSingleRoot = rootNodes.length === 1;

    let endBoundary;
    let boundaryNode;

    if (isSingleRoot && startBoundary) {
        if (startBoundary.expression.type === 'Literal' && startBoundary.expression.value === '@') {
            // The default boundary is a single element with an ID that matches
            // the component ID so in this case there is no need to insert
            // code to assign the boundary to the component def
            return;
        } else {
            boundaryNode = startBoundary.expression;
        }
    } else {
        if (lastNode.type === 'HtmlElement') {
            endBoundary = getBoundaryForNode(lastNode, END, builder);
        } else {
            const extraEnd = builder.htmlComment([
                builder.literal('$'),
                builder.memberExpression(builder.identifier('__component'), builder.identifier('id'))
            ]);
            lastNode.insertSiblingAfter(extraEnd);
            rootNodes.push(extraEnd);
            lastNode = extraEnd;
        }

        if (startBoundary && endBoundary) {
            boundaryNode = builder.arrayExpression([startBoundary.expression, endBoundary.expression]);
        } else if (startBoundary && !endBoundary) {
            boundaryNode = builder.arrayExpression([startBoundary.expression]);
        } else if (!startBoundary && endBoundary) {
            boundaryNode = builder.arrayExpression([builder.literalNull(), endBoundary.expression]);
        } else {
            boundaryNode = builder.arrayExpression([]);
        }
    }

    if (!isDynamic) {
        boundaryNode = context.addStaticVar('marko_componentBoundary', boundaryNode);
    }

    const lhs = builder.memberExpression(builder.identifier('__component'), builder.identifier('boundary'));
    const assignment = builder.assignment(lhs, boundaryNode);
    lastNode.insertSiblingAfter(assignment);
}

module.exports = function handleComponentBind(options) {
    if (this.firstBind) {
        return;
    }

    this.firstBind = true;

    let context = this.context;
    let builder = this.builder;

    let isLegacyComponent = this.isLegacyComponent = options.isLegacyComponent === true;
    let componentModule = options.componentModule;
    let rendererModule = options.rendererModule;
    let componentProps = options.componentProps || {};
    let rootNodes = options.rootNodes;

    insertBoundaryNodes(rootNodes, context, builder);

    var isSplit = false;

    if ((rendererModule && rendererModule !== componentModule) ||
        (!rendererModule && componentModule)) {
        componentProps.split = isSplit = true;
    }

    if (componentModule) {
        let componentTypeNode;
        let dependencyModule = isLegacyComponent || isSplit ? componentModule : this.getTemplateModule();

        if (dependencyModule.requirePath) {
            context.addDependency({ type:'require', path: dependencyModule.requirePath });
        }

        if (isSplit) {
            context.addDependency({ type:'require', path: context.markoModulePrefix + 'components' });
        }

        componentTypeNode = context.addStaticVar(
            'marko_componentType',
            generateRegisterComponentCode(componentModule, this, isSplit));

        componentProps.type = componentTypeNode;
    }

    let markoComponentVar;

    if (rendererModule) {
        if (rendererModule.inlineId) {
            markoComponentVar = rendererModule.inlineId;
        } else {
            markoComponentVar = context.addStaticVar('marko_component', builder.require(builder.literal(rendererModule.requirePath)));
        }
    }

    this.setHasBoundComponentForTemplate();

    var rendererHelper = isLegacyComponent ?
        this.context.helper('rendererLegacy') :
        this.context.helper('renderer');

    var defineComponentHelper;

    if (!isSplit && !isLegacyComponent) {
        defineComponentHelper = this.context.helper('defineComponent');
    }

    this.context.on('beforeGenerateCode:TemplateRoot', function(eventArgs) {
        eventArgs.node.addRenderFunctionParam(builder.identifier('__component'));

        if (isLegacyComponent) {
            eventArgs.node.addRenderFunctionParam(builder.identifier('widget'));
        } else {
            eventArgs.node.addRenderFunctionParam(builder.identifier('component'));
            eventArgs.node.addRenderFunctionParam(builder.identifier('state'));
        }

        eventArgs.node.generateAssignRenderCode = (eventArgs) => {
            const nodes = [];
            const templateVar = eventArgs.templateVar;
            const templateRendererMember = eventArgs.templateRendererMember;
            const renderFunctionVar = eventArgs.renderFunctionVar;

            const createRendererArgs = [
                renderFunctionVar,
                builder.literal(componentProps)
            ];

            if (markoComponentVar) {
                createRendererArgs.push(markoComponentVar);
            }

            nodes.push(builder.assignment(
                templateRendererMember,
                builder.functionCall(
                    rendererHelper,
                    createRendererArgs)));

            if (!isSplit && !isLegacyComponent) {
                nodes.push(builder.assignment(
                    builder.memberExpression(templateVar, builder.identifier('Component')),
                    builder.functionCall(
                        defineComponentHelper,
                        [
                            markoComponentVar,
                            templateRendererMember
                        ])));
            }

            return nodes;
        };
    });
};
