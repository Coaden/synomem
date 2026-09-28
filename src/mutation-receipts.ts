export interface MutationReceipt {
  operation: string;
  requestHash: string;
  resultJson: string | null;
  eventId?: string;
  createdAt: string;
}
