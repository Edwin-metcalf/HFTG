import { Node } from './network/nodes.ts'
import { Link } from './network/links.ts';

export class Firm {
    //this represents the player where the upgrades and interactions will be
    //this is more of the controller not actually the visual or logic of the things
    //in the game
    money: number;
    reputation: number;
    researchLevel: number;

    ownedNodes: Node[];
    ownedLinks: Link[]

    constructor() {
        this.money = 1000;
        this.reputation = 50;
        this.researchLevel = 0;

        this.ownedLinks = [];
        this.ownedNodes = [];

    }
}