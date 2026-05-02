import type { CustomMessage } from "./messages";

export interface PendingSessionMessagesSnapshot {
	steering: string[];
	followUp: string[];
	nextTurn: CustomMessage[];
	scheduledHiddenNextTurnGeneration: number | undefined;
}

export class PendingSessionMessages {
	#steering: string[] = [];
	#followUp: string[] = [];
	#nextTurn: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;

	addSteering(displayText: string): void {
		this.#steering.push(displayText);
	}

	addFollowUp(displayText: string): void {
		this.#followUp.push(displayText);
	}

	removeVisibleMessage(messageText: string): void {
		const steeringIndex = this.#steering.indexOf(messageText);
		if (steeringIndex !== -1) {
			this.#steering.splice(steeringIndex, 1);
			return;
		}

		const followUpIndex = this.#followUp.indexOf(messageText);
		if (followUpIndex !== -1) {
			this.#followUp.splice(followUpIndex, 1);
		}
	}

	addNextTurn(message: CustomMessage): void {
		this.#nextTurn.push(message);
	}

	hasNextTurn(): boolean {
		return this.#nextTurn.length > 0;
	}

	takeNextTurn(): CustomMessage[] {
		const messages = [...this.#nextTurn];
		this.#nextTurn = [];
		return messages;
	}

	restoreNextTurn(messages: CustomMessage[]): void {
		this.#nextTurn = [...messages, ...this.#nextTurn];
	}

	clearNextTurn(): void {
		this.#nextTurn = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
	}

	scheduleHiddenNextTurn(generation: number): boolean {
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return false;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		return true;
	}

	clearScheduledHiddenNextTurn(generation?: number): void {
		if (generation === undefined || this.#scheduledHiddenNextTurnGeneration === generation) {
			this.#scheduledHiddenNextTurnGeneration = undefined;
		}
	}

	clearVisibleQueues(): { steering: string[]; followUp: string[] } {
		const steering = [...this.#steering];
		const followUp = [...this.#followUp];
		this.#steering = [];
		this.#followUp = [];
		return { steering, followUp };
	}

	get count(): number {
		return this.#steering.length + this.#followUp.length + this.#nextTurn.length;
	}

	getVisibleMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return { steering: this.#steering, followUp: this.#followUp };
	}

	popSteering(): string | undefined {
		return this.#steering.pop();
	}

	popFollowUp(): string | undefined {
		return this.#followUp.pop();
	}

	reset(): void {
		this.#steering = [];
		this.#followUp = [];
		this.#nextTurn = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
	}

	capture(): PendingSessionMessagesSnapshot {
		return {
			steering: [...this.#steering],
			followUp: [...this.#followUp],
			nextTurn: [...this.#nextTurn],
			scheduledHiddenNextTurnGeneration: this.#scheduledHiddenNextTurnGeneration,
		};
	}

	restore(snapshot: PendingSessionMessagesSnapshot): void {
		this.#steering = [...snapshot.steering];
		this.#followUp = [...snapshot.followUp];
		this.#nextTurn = [...snapshot.nextTurn];
		this.#scheduledHiddenNextTurnGeneration = snapshot.scheduledHiddenNextTurnGeneration;
	}
}
